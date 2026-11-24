// Minimal RFC 5322 / MIME message builder for the browser.
// buildMime({...}) -> Uint8Array of a complete raw email.

const enc = new TextEncoder();
const CRLF = "\r\n";

const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);

function b64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const wrap76 = (s) => s.replace(/.{1,76}/g, (line) => line + CRLF);

// RFC 2047 encoded-word for non-ASCII header text (split so each word stays short).
export function encodeWord(text) {
  if (isAscii(text) && text.length <= 150) return text;
  const words = [];
  let chunk = "";
  for (const ch of text) {
    if (enc.encode(chunk + ch).length > 45) { words.push(chunk); chunk = ""; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${b64(enc.encode(w))}?=`).join(CRLF + " ");
}

export function formatAddress(a) {
  if (!a) return "";
  const address = a.address.trim();
  const name = (a.name || "").trim();
  if (!name) return address;
  if (isAscii(name)) return `"${name.replace(/(["\\])/g, "\\$1")}" <${address}>`;
  return `${encodeWord(name)} <${address}>`;
}
const formatList = (list) => (list || []).map(formatAddress).join("," + CRLF + " ");

export function rfc5322Date(d = new Date()) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${days[d.getDay()]}, ${p(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}

function fileParam(param, name) {
  const safe = (name || "attachment").replace(/[\r\n"\\]/g, "_").slice(0, 200);
  if (isAscii(safe)) return `${param}="${safe}"`;
  // RFC 2231 (standard) first, RFC 2047 encoded-word as the widely supported fallback (what Gmail sends)
  return `${param}*=UTF-8''${encodeURIComponent(safe)}; ${param}="${encodeWord(safe).replace(/\r\n /g, "")}"`;
}

// ids come from other people's emails: allow only visible ASCII without < > (no CR/LF header injection)
const safeId = (id) => String(id || "").replace(/[^\x21-\x3b\x3d\x3f-\x7e]/g, "").slice(0, 250);

const boundary = () => "=_" + crypto.randomUUID().replace(/-/g, "");

function textPart(type, content) {
  return `Content-Type: ${type}; charset=UTF-8${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    wrap76(b64(enc.encode(content)));
}

function attachmentPart(att) {
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(att.contentType || "") ? att.contentType : "application/octet-stream";
  const disp = att.contentId ? "inline" : "attachment";
  return `Content-Type: ${type}; ${fileParam("name", att.filename)}${CRLF}` +
    `Content-Disposition: ${disp}; ${fileParam("filename", att.filename)}${CRLF}` +
    (safeId(att.contentId) ? `Content-ID: <${safeId(att.contentId)}>${CRLF}` : "") +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` + wrap76(b64(att.data));
}

/**
 * @param {object} m
 *  from {name,address}, to/cc/bcc [{name,address}], subject, text, html,
 *  attachments [{filename, contentType, data: Uint8Array}], messageId, inReplyTo, references [ids],
 *  date (Date), includeBcc (only for the stored Sent copy)
 */
export function buildMime(m) {
  const headers = [];
  headers.push(`From: ${formatAddress(m.from)}`);
  if (m.to && m.to.length) headers.push(`To: ${formatList(m.to)}`);
  if (m.cc && m.cc.length) headers.push(`Cc: ${formatList(m.cc)}`);
  if (m.includeBcc && m.bcc && m.bcc.length) headers.push(`Bcc: ${formatList(m.bcc)}`);
  if (m.replyTo) headers.push(`Reply-To: ${formatAddress(m.replyTo)}`);
  headers.push(`Subject: ${encodeWord(m.subject || "")}`);
  headers.push(`Date: ${rfc5322Date(m.date || new Date())}`);
  if (safeId(m.messageId)) headers.push(`Message-ID: <${safeId(m.messageId)}>`);
  if (safeId(m.inReplyTo)) headers.push(`In-Reply-To: <${safeId(m.inReplyTo)}>`);
  const refs = (m.references || []).map(safeId).filter(Boolean);
  if (refs.length) headers.push(`References: ${refs.map((r) => `<${r}>`).join(CRLF + " ")}`);
  headers.push("MIME-Version: 1.0");
  headers.push("X-Mailer: serverless-webmail");

  const alt = boundary();
  const alternative =
    `Content-Type: multipart/alternative; boundary="${alt}"${CRLF}${CRLF}` +
    `--${alt}${CRLF}${textPart("text/plain", m.text || "")}` +
    `--${alt}${CRLF}${textPart("text/html", m.html || "")}` +
    `--${alt}--${CRLF}`;

  let body;
  const atts = m.attachments || [];
  if (atts.length) {
    const mixed = boundary();
    body = `Content-Type: multipart/mixed; boundary="${mixed}"${CRLF}${CRLF}` +
      `--${mixed}${CRLF}${alternative}` +
      atts.map((a) => `--${mixed}${CRLF}${attachmentPart(a)}`).join("") +
      `--${mixed}--${CRLF}`;
  } else {
    body = alternative;
  }
  return enc.encode(headers.join(CRLF) + CRLF + body);
}
