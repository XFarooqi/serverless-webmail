#!/usr/bin/env bash
# Deploy a static website + a serverless webmail for your domain to AWS (us-east-1).
#
#   ./deploy.sh example.com
#
# Optional environment variables:
#   ALERT_EMAIL=you@gmail.com   send bounce/complaint/abuse alerts here (SNS; confirm the email AWS sends)
#   MAIL_USER=admin             username for the webmail login (default: admin)
#   SITE_DIR=../my-site         folder published at https://example.com/ (default: ./site)
#
# Safe to rerun at any time. Each run:
#   1. finds or requests the ACM certificate; stops and prints the validation records if it is
#      not ISSUED yet (add them at your DNS provider, wait a few minutes, rerun);
#   2. deploys/updates the CloudFormation stack;
#   3. activates the SES receipt rule set;
#   4. creates the webmail login on the first run (password saved to .webmail-login, mode 600);
#   5. builds the site (SITE_DIR + /mail/ webmail + 404) and uploads it, then clears the CDN cache;
#   6. prints every DNS record you need (also saved to dns-records.txt).
#
# The webmail is served from https://mail.<domain>/mail/ (its own origin, isolated from the website).
set -euo pipefail

DOMAIN="$(printf '%s' "${1:?Usage: ./deploy.sh yourdomain.com}" | tr '[:upper:]' '[:lower:]')"
HERE="$(cd "$(dirname "$0")" && pwd)"
SITE_DIR="${SITE_DIR:-$HERE/site}"
STACK="webmail-$(printf '%s' "$DOMAIN" | tr '.' '-')"
MAIL_USER="${MAIL_USER:-admin}"
ALERT_EMAIL="${ALERT_EMAIL:-}"
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""

[ -d "$SITE_DIR" ] || { echo "SITE_DIR '$SITE_DIR' not found." >&2; exit 1; }
for cmd in aws python3; do command -v "$cmd" >/dev/null || { echo "Missing '$cmd'." >&2; exit 1; }; done

# DNS "host" field relative to the domain, e.g. "_x.www.example.com." -> "_x.www"
host_for() {
  local n="${1%.}"
  if [ "$n" = "$DOMAIN" ]; then printf '@'; else printf '%s' "${n%."$DOMAIN"}"; fi
}

echo "AWS account: $(aws sts get-caller-identity --query Account --output text)   stack: $STACK"

# ------------------------------------------------------------ 1. certificate
# Reuse a certificate only if it covers all three names (example.com, www.example.com, mail.example.com).
NEEDED="$DOMAIN www.$DOMAIN mail.$DOMAIN"
CERT=""
for ARN in $(aws acm list-certificates --certificate-statuses PENDING_VALIDATION ISSUED \
    --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn" --output text); do
  SANS=" $(aws acm describe-certificate --certificate-arn "$ARN" --query 'Certificate.SubjectAlternativeNames' --output text | tr '\t' ' ') "
  OK=1; for n in $NEEDED; do case "$SANS" in *" $n "*) ;; *) OK=0 ;; esac; done
  [ "$OK" = 1 ] || continue
  ST=$(aws acm describe-certificate --certificate-arn "$ARN" --query Certificate.Status --output text)
  if [ "$ST" = "ISSUED" ]; then CERT="$ARN"; break; fi
  [ -z "$CERT" ] && CERT="$ARN"
done
if [ -z "$CERT" ]; then
  CERT=$(aws acm request-certificate --domain-name "$DOMAIN" --subject-alternative-names "www.$DOMAIN" "mail.$DOMAIN" \
    --validation-method DNS --query CertificateArn --output text)
  echo "Requested certificate $CERT (for $DOMAIN, www.$DOMAIN and mail.$DOMAIN)"
fi
for _ in $(seq 1 24); do   # validation records appear a few seconds after the request
  N=$(aws acm describe-certificate --certificate-arn "$CERT" \
    --query 'length(Certificate.DomainValidationOptions[?ResourceRecord])' --output text)
  [ "$N" = "3" ] && break
  sleep 5
done
STATUS=$(aws acm describe-certificate --certificate-arn "$CERT" --query Certificate.Status --output text)
CERT_RECORDS=$(aws acm describe-certificate --certificate-arn "$CERT" \
  --query 'Certificate.DomainValidationOptions[].ResourceRecord.[Name,Value]' --output text | sort -u)

if [ "$STATUS" != "ISSUED" ]; then
  echo
  echo "Certificate status: $STATUS. Add these CNAME records at your DNS provider, wait a few minutes, then rerun."
  echo "(Running it again too early is harmless: it just prints the same records.)"
  printf '%s\n' "$CERT_RECORDS" | while read -r name value; do
    printf '  CNAME  %-40s %s\n' "$(host_for "$name")" "$value"
  done
  exit 0
fi
echo "Certificate ISSUED."

# ------------------------------------------------------------------ 2. stack
fail_reason() {
  aws cloudformation describe-stack-events --stack-name "$STACK" \
    --query "StackEvents[?contains(ResourceStatus,'FAILED')].[LogicalResourceId,ResourceStatusReason]" --output text 2>/dev/null \
    | grep -v 'cancelled' | tail -3 | sed 's/^/    /' >&2 || true
}
# A first attempt that failed leaves the stack in ROLLBACK_COMPLETE, which can't be updated: show why, remove it, retry.
PREV=$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)
if [ "$PREV" = "ROLLBACK_COMPLETE" ]; then
  echo "An earlier attempt to create $STACK failed. AWS said:" >&2; fail_reason
  echo "Removing the failed stack and trying again..."
  aws cloudformation delete-stack --stack-name "$STACK"
  aws cloudformation wait stack-delete-complete --stack-name "$STACK"
fi
PARAMS=(DomainName="$DOMAIN" CertificateArn="$CERT")
[ -n "$ALERT_EMAIL" ] && PARAMS+=(AlertEmail="$ALERT_EMAIL")   # omitted = keep the value from the last run
echo "Deploying CloudFormation stack (CloudFront takes a few minutes the first time)..."
if ! aws cloudformation deploy --stack-name "$STACK" --template-file "$HERE/template.yaml" \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides "${PARAMS[@]}"; then
  echo >&2; echo "Deployment failed. AWS said:" >&2; fail_reason
  echo "Common causes: another CloudFront distribution still uses $DOMAIN, www.$DOMAIN or mail.$DOMAIN" >&2
  echo "(remove them from its Alternate domain names), or SES receiving isn't available yet. Fix it and rerun." >&2
  exit 1
fi
OUTPUTS=$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text)
out() { printf '%s\n' "$OUTPUTS" | awk -v k="$1" '$1 == k { print $2 }'; }

# ---------------------------------------------------- 3. activate SES rules
RULESET=$(out ReceiptRuleSetName)
ACTIVE=$(aws ses describe-active-receipt-rule-set --query Metadata.Name --output text 2>/dev/null || true)
if [ "$ACTIVE" != "$RULESET" ]; then
  if [ -n "$ACTIVE" ] && [ "$ACTIVE" != "None" ]; then
    echo "Another SES receipt rule set ('$ACTIVE') is active in us-east-1. Only one can be active per region," >&2
    echo "so this script won't replace it. Merge the rule into it, or activate '$RULESET' yourself." >&2
    exit 1
  fi
  aws ses set-active-receipt-rule-set --rule-set-name "$RULESET"
  echo "Activated SES rule set $RULESET"
fi

# ------------------------------------------------------- 4. webmail login
POOL=$(out UserPoolId)
if [ "$(aws cognito-idp list-users --user-pool-id "$POOL" --query 'length(Users)' --output text)" = "0" ]; then
  PASS="$(python3 -I -c 'import secrets,string; a=string.ascii_letters+string.digits; p="".join(secrets.choice(a) for _ in range(20)); print("Aa1"+p)')"
  aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$MAIL_USER" --message-action SUPPRESS >/dev/null
  TMP="$(mktemp)"; chmod 600 "$TMP"
  # the password goes through a private temp file, never on the command line
  printf '%s' "$PASS" | python3 -I -c 'import json,sys; print(json.dumps({"UserPoolId":sys.argv[1],"Username":sys.argv[2],"Password":sys.stdin.read(),"Permanent":True}))' "$POOL" "$MAIL_USER" > "$TMP"
  if ! aws cognito-idp admin-set-user-password --cli-input-json "file://$TMP"; then
    rm -f "$TMP"
    aws cognito-idp admin-delete-user --user-pool-id "$POOL" --username "$MAIL_USER"
    echo "Could not set the webmail password." >&2; exit 1
  fi
  rm -f "$TMP"
  umask 077
  printf 'Webmail: https://mail.%s/mail/\nUsername: %s\nPassword: %s\n' "$DOMAIN" "$MAIL_USER" "$PASS" > "$HERE/.webmail-login"
  chmod 600 "$HERE/.webmail-login"
  unset PASS
  echo "Created webmail user '$MAIL_USER' (password saved in $HERE/.webmail-login)"
fi

# ------------------------------------------------------ 5. build + upload
DIST="$(mktemp -d)"
trap 'rm -rf "$DIST"' EXIT
# copy the site, then drop dotfiles/folders (.git, .DS_Store...) and Markdown notes (works on macOS, Linux, AWS CloudShell)
cp -R "$SITE_DIR/." "$DIST/"
find "$DIST" -mindepth 1 \( \( -name '.*' ! -name '.well-known' \) -o -name '*.md' -o -name '__MACOSX' \) -prune -exec rm -rf {} +
[ -f "$DIST/index.html" ] || echo "WARNING: no index.html at the top of SITE_DIR ($SITE_DIR); your home page will show the 404 page." >&2
[ -f "$DIST/404.html" ] || cp "$HERE/site/404.html" "$DIST/404.html"
mkdir -p "$DIST/mail"
cp -R "$HERE/webmail/." "$DIST/mail/"
cat > "$DIST/mail/config.js" <<EOF
window.MAIL_CONFIG = {
  domain: "$DOMAIN",
  region: "us-east-1",
  userPoolId: "$POOL",
  clientId: "$(out UserPoolClientId)",
  identityPoolId: "$(out IdentityPoolId)",
  bucket: "$(out MailBucketName)",
  prefix: "emails/",
  configurationSet: "$(out SendingConfigurationSetName)"
};
EOF
aws s3 sync "$DIST/" "s3://$(out SiteBucketName)/" --delete --only-show-errors --cache-control "public, max-age=300"
aws cloudfront create-invalidation --distribution-id "$(out DistributionId)" --paths '/*' >/dev/null
echo "Uploaded site and cleared the CloudFront cache."

# ---------------------------------------------------------- 6. DNS records
CF=$(out DistributionDomainName)
{
  echo "DNS records for $DOMAIN (add them at your DNS provider; host is relative to the domain, @ = apex)"
  echo
  echo "Certificate validation (keep them; ACM uses them to auto-renew):"
  printf '%s\n' "$CERT_RECORDS" | while read -r name value; do
    printf '  CNAME  %-40s %s\n' "$(host_for "$name")" "$value"
  done
  echo
  echo "Website:"
  printf '  ALIAS  %-40s %s   (ALIAS/ANAME/CNAME flattening; Route 53: A-alias)\n' "@" "$CF"
  printf '  CNAME  %-40s %s\n' "www" "$CF"
  printf '  CNAME  %-40s %s   (the webmail)\n' "mail" "$CF"
  echo
  echo "Email:"
  for i in 1 2 3; do
    printf '  CNAME  %-40s %s\n' "$(host_for "$(out DkimName$i)")" "$(out DkimValue$i)"
  done
  printf '  MX     %-40s %s (priority 10)\n' "@" "inbound-smtp.us-east-1.amazonaws.com"
  printf '  TXT    %-40s %s\n' "@" "v=spf1 include:amazonses.com ~all   (if you already have a v=spf1 record, add include:amazonses.com to it instead)"
  printf '  TXT    %-40s %s\n' "_dmarc" "v=DMARC1; p=none; rua=mailto:dmarc@$DOMAIN; adkim=r; aspf=r"
} | tee "$HERE/dns-records.txt"

echo
DKIM=$(aws sesv2 get-email-identity --email-identity "$DOMAIN" --query 'DkimAttributes.Status' --output text)
echo "SES domain verification (DKIM): $DKIM"
if [ "$DKIM" != "SUCCESS" ]; then
  echo "      Expected until the 3 _domainkey CNAMEs above are live (usually under an hour). Sending works once it says SUCCESS."
  echo "      Check later: aws sesv2 get-email-identity --region us-east-1 --email-identity $DOMAIN --query DkimAttributes.Status"
fi
if [ "$(aws sesv2 get-account --query ProductionAccessEnabled --output text)" != "True" ]; then
  echo "NOTE: your SES account is in the sandbox, so you can only send to verified addresses."
  echo "      Request production access (free) - see README 'Sending to any address'."
fi
echo "Site:    https://$DOMAIN/"
echo "Webmail: https://mail.$DOMAIN/mail/   (login: cat $HERE/.webmail-login)"
