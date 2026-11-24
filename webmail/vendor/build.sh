#!/usr/bin/env bash
# Rebuild vendor.js + tailwind.js from the exact versions in VERSIONS.txt (run from anywhere).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cd "$TMP" && npm init -y >/dev/null
npm install --save-exact --no-audit --no-fund $(grep -v '^\s*$' "$HERE/VERSIONS.txt" | tr '\n' ' ')
cp "$HERE/entry.js" entry.js
npx esbuild entry.js --bundle --format=esm --platform=browser --target=es2022 --minify --legal-comments=linked --outfile=vendor.js
cp vendor.js "$HERE/vendor.js"; cp vendor.js.LEGAL.txt "$HERE/LICENSES.txt"
cp node_modules/@tailwindcss/browser/dist/index.global.js "$HERE/tailwind.js"
echo "vendor rebuilt"
