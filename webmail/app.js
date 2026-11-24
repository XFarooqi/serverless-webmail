// Serverless webmail for a single user.
// Reads/sends via the browser only: Cognito (login, 2FA) -> Identity Pool -> scoped IAM role -> S3 + SES.
import {
  S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand,
  SESv2Client, SendEmailCommand,
  CognitoIdentityProviderClient, InitiateAuthCommand, RespondToAuthChallengeCommand, RevokeTokenCommand,
  ChangePasswordCommand, AssociateSoftwareTokenCommand, VerifySoftwareTokenCommand, SetUserMFAPreferenceCommand,
  GetUserCommand, GlobalSignOutCommand,
  CognitoIdentityClient, fromCognitoIdentityPool, PostalMime, DOMPurify, QRCode,
} from "/mail/vendor/vendor.js"; // pinned + bundled locally (see vendor/VERSIONS.txt)
import { buildMime } from "/mail/mime.js";

// =================================================================== config
const C = window.MAIL_CONFIG;
if (!C) { document.body.textContent = "config.js is missing. Run deploy.sh to generate it."; throw new Error("missing config"); }
const DOMAIN = C.domain.toLowerCase();
const LS = `mm2:${C.bucket}:`;
const STATE_KEY = "state/state.json";
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
const TRASH_DAYS = 30;
const $ = (id) => document.getElementById(id);

// ================================================================ dom utils
function append(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid)); // strings are always text, never HTML
  }
  return el;
}
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value" || k === "checked" || k === "selected") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  return append(el, kids);
}

const SVGNS = "http://www.w3.org/2000/svg";
const ICONS = {
  inbox: "M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z",
  star: "M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z",
  sent: "M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5",
  draft: "m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10",
  archive: "m20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z",
  spam: "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z",
  trash: "m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0",
  at: "M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Zm0 0c0 1.657 1.007 3 2.25 3S21 13.657 21 12a9 9 0 1 0-2.636 6.364M16.5 12V8.25",
  all: "M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z",
  reply: "M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3",
  replyAll: ["M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3", "M13 15 7 9l6-6"],
  forward: "m15 15 6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3",
  clip: "m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13",
  unread: "M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75",
  read: "M21.75 9v.906a2.25 2.25 0 0 1-1.183 1.981l-6.478 3.488M2.25 9v.906a2.25 2.25 0 0 0 1.183 1.981l6.478 3.488m8.839 2.51-4.66-2.51m0 0-1.023-.55a2.25 2.25 0 0 0-2.134 0l-1.022.55m0 0-4.661 2.51m16.5 1.615a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V8.844a2.25 2.25 0 0 1 1.183-1.981l7.5-4.039a2.25 2.25 0 0 1 2.134 0l7.5 4.039a2.25 2.25 0 0 1 1.183 1.98V19.5Z",
  back: "M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18",
  refresh: "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99",
  cog: ["M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 0 1 1.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.559.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.894.149c-.424.07-.764.383-.929.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 0 1-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.398.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 0 1-.12-1.45l.527-.737c.25-.35.272-.806.108-1.204-.165-.397-.506-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.108-1.204l-.526-.738a1.125 1.125 0 0 1 .12-1.45l.773-.773a1.125 1.125 0 0 1 1.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894Z", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"],
  search: "m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z",
  x: "M6 18 18 6M6 6l12 12",
  minus: "M5 12h14",
  expand: "M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15",
  dots: "M12 6.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 12.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 18.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z",
  menu: "M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5",
  shield: "M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z",
  photo: "m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z",
  print: "M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0 1 10.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0 .229 2.523a1.125 1.125 0 0 1-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0 0 21 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 0 0-1.913-.247M6.34 18H5.25A2.25 2.25 0 0 1 3 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 0 1 1.913-.247m10.5 0a48.536 48.536 0 0 0-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5Zm-3 0h.008v.008H15V10.5Z",
  download: "M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3",
  code: "M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5",
  link: "M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244",
  bullets: "M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z",
  numbers: "M8.242 5.992h12m-12 6.003H20.24m-12 5.999h12M4.117 7.495v-3.75H2.99m1.125 3.75H2.99m1.125 0H5.24m-1.92 2.577a1.125 1.125 0 1 1 1.591 1.59l-1.83 1.83h2.16M2.99 15.745h1.125a1.125 1.125 0 0 1 0 2.25H3.74m0-.002h.375a1.125 1.125 0 0 1 0 2.25H2.99",
  quote: "M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z",
  check: "m4.5 12.75 6 6 9-13.5",
  down: "m19.5 8.25-7.5 7.5-7.5-7.5",
  signout: "M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9",
  keyboard: "m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z",
  file: "M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z",
  eye: ["M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"],
  pencil: "m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Z",
};
function icon(name, cls = "h-5 w-5", filled = false) {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", filled ? "currentColor" : "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  for (const d of [].concat(ICONS[name] || [])) {
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", d);
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    svg.append(p);
  }
  return svg;
}
const iconBtn = (name, title, onclick, extra = "", filled = false) =>
  h("button", { class: `icon-btn ${extra}`, title, "aria-label": title, onclick }, icon(name, "h-5 w-5", filled));

// ----------------------------------------------------------------- toasts
function toast(message, { action, timeout = 5000, dismissible = true } = {}) {
  const text = h("span", { class: "flex-1" }, message);
  const el = h("div", { class: "flex min-w-72 max-w-md items-center gap-4 rounded-lg bg-slate-900 px-4 py-3 text-sm text-white shadow-lg dark:bg-slate-100 dark:text-slate-900" }, text);
  let timer;
  const close = () => { clearTimeout(timer); el.remove(); };
  if (action) el.append(h("button", { class: "font-semibold text-blue-300 hover:underline dark:text-blue-700", onclick: () => { close(); action.fn(); } }, action.label));
  if (dismissible) el.append(h("button", { class: "opacity-60 hover:opacity-100", onclick: close, "aria-label": "Dismiss" }, "✕"));
  $("toasts").append(el);
  if (timeout) timer = setTimeout(close, timeout);
  return { close, set: (t) => { text.textContent = t; } };
}

// ------------------------------------------------------------------ menus
let openMenuEl = null;
function closeMenu() {
  if (!openMenuEl) return;
  openMenuEl.remove();
  openMenuEl = null;
  document.removeEventListener("pointerdown", outsideMenu, true);
}
function outsideMenu(e) { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); }
function showMenu(anchor, items) {
  closeMenu();
  const r = anchor.getBoundingClientRect();
  const m = h("div", { class: "menu", style: "position:fixed;left:0;top:0" },
    items.filter(Boolean).map((it) => it === "-"
      ? h("div", { class: "my-1 border-t border-slate-200 dark:border-slate-700" })
      : h("button", { class: `menu-item ${it.danger ? "text-red-600 dark:text-red-400" : ""}`, onclick: () => { closeMenu(); it.onClick(); } },
          it.icon ? icon(it.icon, "h-4 w-4 opacity-70") : h("span", { class: "w-4" }), it.label)));
  $("menus").append(m);
  const left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8));
  let top = r.bottom + 4;
  if (top + m.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - m.offsetHeight - 4);
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
  openMenuEl = m;
  setTimeout(() => document.addEventListener("pointerdown", outsideMenu, true), 0);
}

// ------------------------------------------------------------- formatting
function fmtDate(d) {
  const t = new Date(d);
  if (isNaN(t)) return "";
  const now = new Date();
  if (t.toDateString() === now.toDateString()) return t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return t.toLocaleDateString([], { month: "short", day: "numeric", year: t.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
const fmtFull = (d) => { const t = new Date(d); return isNaN(t) ? "" : t.toLocaleString([], { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
function relTime(d) {
  const s = (Date.now() - new Date(d)) / 1000;
  if (!(s >= 0)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${plural(Math.floor(s / 3600), "hour")} ago`;
  if (s < 86400 * 7) return `${plural(Math.floor(s / 86400), "day")} ago`;
  return "";
}
function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const EMAIL_RE = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[a-z]{2,}$/i;
const isMine = (addr) => (addr || "").toLowerCase().endsWith("@" + DOMAIN);
const fmtAddr = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : "");
const nameOf = (a) => (a ? (a.name || a.address.split("@")[0]) : "");
const shortName = (a) => (a ? (isMine(a.address) ? "me" : nameOf(a)) : "");
function parseAddresses(text) {
  const out = [];
  let buf = "", quoted = false, angle = false;
  const push = () => {
    const s = buf.trim();
    buf = "";
    if (!s) return;
    const m = s.match(/^(.*)<([^>]+)>\s*$/);
    if (m) out.push({ name: m[1].trim().replace(/^"|"$/g, ""), address: m[2].trim().toLowerCase() });
    else out.push({ name: "", address: s.replace(/^mailto:/i, "").toLowerCase() });
  };
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === "<") angle = true;
    if (ch === ">") angle = false;
    if ((ch === "," || ch === ";" || ch === "\n") && !quoted && !angle) push();
    else buf += ch;
  }
  push();
  return out;
}
const AVATAR_COLORS = ["bg-rose-500", "bg-orange-500", "bg-amber-500", "bg-emerald-500", "bg-teal-500", "bg-sky-500", "bg-indigo-500", "bg-fuchsia-500", "bg-violet-500", "bg-lime-600"];
function avatar(a, size = "h-9 w-9 text-sm") {
  const label = (a && (a.name || a.address) || "?").trim();
  let hash = 0;
  for (const ch of (a && a.address) || label) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return h("span", { class: `inline-flex shrink-0 items-center justify-center rounded-full font-semibold uppercase text-white ${size} ${AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]}` }, label.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1) || "?");
}
function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); return fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html"); // inert: no scripts, no fetches
  doc.querySelectorAll("style,script,head,title").forEach((n) => n.remove());
  doc.querySelectorAll("br").forEach((n) => n.replaceWith("\n"));
  doc.querySelectorAll("p,div,li,tr,h1,h2,h3,h4,blockquote").forEach((n) => n.append("\n"));
  return (doc.body ? doc.body.textContent : "").replace(/\n{3,}/g, "\n\n").trim();
}
function b64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cleanId = (s) => (s || "").trim().replace(/^<|>$/g, "").trim();
const parseRefs = (s) => [...String(s || "").matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
function saveBlob(bytes, filename) {
  // Always octet-stream: an attached .html/.svg can never render on this origin.
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = h("a", { href: url, download: filename || "download" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Sanitiser for HTML we put into OUR editor (reply quotes, forwards, pastes, signature).
const SANITIZE = {
  ALLOWED_TAGS: ["a", "b", "strong", "i", "em", "u", "s", "strike", "br", "p", "div", "span", "ul", "ol", "li", "blockquote", "pre", "code",
    "h1", "h2", "h3", "h4", "table", "thead", "tbody", "tr", "td", "th", "hr", "img", "font", "sub", "sup", "small", "center"],
  ALLOWED_ATTR: ["href", "title", "alt", "src", "colspan", "rowspan", "align", "style", "color", "width", "height"],
  ALLOW_DATA_ATTR: false,
};
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    const href = node.getAttribute("href") || "";
    if (!/^(https?:|mailto:)/i.test(href)) node.removeAttribute("href");
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  if (node.tagName === "IMG" && !/^data:image\/(png|jpe?g|gif|webp);/i.test(node.getAttribute("src") || "")) node.remove();
  if (node.hasAttribute && node.hasAttribute("style")) {
    const kept = node.getAttribute("style").split(";").map((d) => d.trim()).filter((d) => {
      const i = d.indexOf(":");
      if (i < 1) return false;
      const prop = d.slice(0, i).trim().toLowerCase();
      const val = d.slice(i + 1).trim().toLowerCase();
      return SAFE_CSS.has(prop) && !/[\\(]|url|image|expression|@import|javascript/.test(val);
    });
    if (kept.length) node.setAttribute("style", kept.join("; ")); else node.removeAttribute("style");
  }
});
const SAFE_CSS = new Set(["color", "background-color", "font-weight", "font-style", "font-size", "font-family", "text-decoration", "text-align",
  "line-height", "margin", "margin-top", "margin-bottom", "margin-left", "margin-right", "padding", "padding-top", "padding-bottom", "padding-left",
  "padding-right", "border", "border-left", "border-collapse", "vertical-align", "white-space", "width", "max-width", "list-style-type"]);
const sanitize = (html) => DOMPurify.sanitize(html || "", SANITIZE);

// =================================================================== auth
const idp = new CognitoIdentityProviderClient({ region: C.region });
const identity = new CognitoIdentityClient({ region: C.region });
const providerName = `cognito-idp.${C.region}.amazonaws.com/${C.userPoolId}`;
const TOKEN_KEYS = ["idToken", "idExp", "accessToken", "refreshToken"];
const tokenStore = () => (localStorage.getItem("mm2:keep") === "1" ? localStorage : sessionStorage);
const tok = (k) => tokenStore().getItem(k);

class AuthError extends Error { constructor(m = "Please sign in again.") { super(m); this.name = "AuthError"; } }
const AUTH_ERRORS = new Set(["AuthError", "NotAuthorizedException", "ExpiredToken", "ExpiredTokenException", "InvalidIdentityTokenException"]);
const isAuthError = (e) => AUTH_ERRORS.has(e && e.name);

function saveTokens(a) {
  const st = tokenStore();
  st.setItem("idToken", a.IdToken);
  st.setItem("accessToken", a.AccessToken);
  st.setItem("idExp", String(Date.now() + a.ExpiresIn * 1000));
  if (a.RefreshToken) st.setItem("refreshToken", a.RefreshToken);
}
function clearTokens() { for (const st of [localStorage, sessionStorage]) TOKEN_KEYS.forEach((k) => st.removeItem(k)); }
function jwtClaims(t) {
  try { return JSON.parse(decodeURIComponent(escape(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))))); } catch { return {}; }
}
const username = () => jwtClaims(tok("idToken") || "")["cognito:username"] || "";

async function signIn(user, password) {
  const r = await idp.send(new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: C.clientId, AuthParameters: { USERNAME: user, PASSWORD: password } }));
  if (r.ChallengeName === "SOFTWARE_TOKEN_MFA") return { mfa: true, session: r.Session };
  if (r.ChallengeName) throw new Error(`This account needs "${r.ChallengeName}". Ask the administrator.`);
  saveTokens(r.AuthenticationResult);
  return { mfa: false };
}
async function answerMfa(user, code, session) {
  const r = await idp.send(new RespondToAuthChallengeCommand({
    ChallengeName: "SOFTWARE_TOKEN_MFA", ClientId: C.clientId, Session: session,
    ChallengeResponses: { USERNAME: user, SOFTWARE_TOKEN_MFA_CODE: code },
  }));
  saveTokens(r.AuthenticationResult);
}
let refreshing = null;
async function idToken() {
  if (tok("idToken") && Date.now() < Number(tok("idExp")) - 60000) return tok("idToken");
  const refreshToken = tok("refreshToken");
  if (!refreshToken) throw new AuthError();
  refreshing = refreshing || idp.send(new InitiateAuthCommand({ AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: C.clientId, AuthParameters: { REFRESH_TOKEN: refreshToken } }))
    .then((r) => { saveTokens(r.AuthenticationResult); return r.AuthenticationResult.IdToken; })
    .finally(() => { refreshing = null; });
  return refreshing;
}
async function accessToken() { await idToken(); return tok("accessToken"); }

let awsCreds = null;
async function credentials() {
  if (awsCreds && awsCreds.expiration && awsCreds.expiration.getTime() - Date.now() > 120000) return awsCreds;
  const token = await idToken();
  awsCreds = await fromCognitoIdentityPool({ client: identity, identityPoolId: C.identityPoolId, logins: { [providerName]: token } })();
  return awsCreds;
}
const s3 = new S3Client({ region: C.region, credentials, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
const ses = new SESv2Client({ region: C.region, credentials });

// ============================================================== S3 storage
async function listPrefix(prefix) {
  const out = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: C.bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents || []) if (!o.Key.endsWith("/")) out.push({ key: o.Key, modified: new Date(o.LastModified), size: o.Size });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}
async function getBytes(key, range) {
  const r = await s3.send(new GetObjectCommand({ Bucket: C.bucket, Key: key, Range: range }));
  return r.Body.transformToByteArray();
}
const putObject = (key, body, type) => s3.send(new PutObjectCommand({ Bucket: C.bucket, Key: key, Body: body, ContentType: type }));
const deleteObject = (key) => s3.send(new DeleteObjectCommand({ Bucket: C.bucket, Key: key }));

// ===================================================== synced state (S3 JSON)
// msgs[key] = { read, star, arch, trash (timestamp), spam (true/false override), t (last change) }
const DEFAULT_SETTINGS = {
  displayName: "",
  defaultFrom: `hello@${DOMAIN}`,
  aliases: [{ address: `hello@${DOMAIN}`, name: "" }],
  signature: "",
  undoSeconds: 10,
  remoteImages: "ask",
  trustedSenders: [],
  autoRefresh: true,
  notifications: false,
  conversationView: true,
};
const store = { data: { v: 2, msgs: {}, settings: {}, settingsT: 0 }, remoteExists: false, deleted: new Set() };
const S = () => ({ ...DEFAULT_SETTINGS, ...store.data.settings });
const F = (k) => store.data.msgs[k] || {};

// Per-FLAG merge: each flag carries its own timestamp (entry.ts[flag]), so a device that only marks a message
// read can't wipe a star set on another device. Old entries without ts fall back to the entry timestamp.
const FLAG_FIELDS = ["read", "star", "arch", "trash", "spam"];
function mergeEntry(x, y) {
  if (!x) return y;
  if (!y) return x;
  const out = { ts: {}, t: Math.max(x.t || 0, y.t || 0) };
  for (const f of FLAG_FIELDS) {
    const tx = (x.ts && x.ts[f]) ?? (f in x ? x.t || 0 : -1);
    const ty = (y.ts && y.ts[f]) ?? (f in y ? y.t || 0 : -1);
    if (tx < 0 && ty < 0) continue;
    const src = ty >= tx ? y : x;
    out[f] = src[f];
    out.ts[f] = Math.max(tx, ty);
  }
  return out;
}
function mergeState(a, b) {
  const msgs = { ...a.msgs };
  for (const [k, v] of Object.entries(b.msgs || {})) msgs[k] = mergeEntry(msgs[k], v);
  const newer = (b.settingsT || 0) >= (a.settingsT || 0) ? b : a;
  return { v: 2, msgs, settings: newer.settings || {}, settingsT: newer.settingsT || 0 };
}
async function readRemoteState() {
  if (!store.remoteExists) store.remoteExists = (await listPrefix("state/")).some((o) => o.key === STATE_KEY);
  if (!store.remoteExists) return null;
  return JSON.parse(new TextDecoder().decode(await getBytes(STATE_KEY)));
}
async function loadState() {
  const remote = await readRemoteState();
  if (remote) store.data = mergeState({ v: 2, msgs: {}, settings: {}, settingsT: 0 }, remote);
  // one-time migration of read flags from the first webmail version
  const old = localStorage.getItem(`mm1:${C.bucket}:read`);
  if (old && !Object.keys(store.data.msgs).length) {
    const t = Date.now();
    for (const k of JSON.parse(old)) applyFlags(k, { read: true }, t);
    saveState();
  }
}
const saveState = debounce(async () => {
  try {
    const remote = await readRemoteState(); // a failed read aborts the save, so other devices' changes are never overwritten
    if (remote) store.data = mergeState(remote, store.data);
    for (const k of store.deleted) delete store.data.msgs[k]; // only drop flags of mail this tab permanently deleted
    await putObject(STATE_KEY, JSON.stringify(store.data), "application/json");
    store.deleted.clear();
    store.remoteExists = true;
  } catch (e) {
    if (isAuthError(e)) return handleError(e);
    console.error(e);
    toast("Couldn't sync changes. They'll retry with your next action.");
  }
}, 1200);
function applyFlags(k, patch, t) {
  const cur = store.data.msgs[k] || {};
  const ts = { ...(cur.ts || {}) };
  for (const f of Object.keys(patch)) ts[f] = t;
  store.data.msgs[k] = { ...cur, ...patch, ts, t };
}
function setFlags(keys, patch, undoLabel) {
  const t = Date.now();
  const fields = Object.keys(patch);
  const before = keys.map((k) => [k, Object.fromEntries(fields.map((f) => [f, (store.data.msgs[k] || {})[f]]))]);
  for (const k of keys) applyFlags(k, patch, t);
  saveState();
  render();
  if (undoLabel) toast(undoLabel, { action: { label: "Undo", fn: () => {
    const t2 = Date.now();
    // restore only the flags this action changed (undefined -> neutral value)
    for (const [k, prev] of before) applyFlags(k, Object.fromEntries(fields.map((f) => [f, prev[f] ?? (f === "trash" ? 0 : f === "spam" ? null : false)])), t2);
    saveState();
    render();
  } } });
}
function setSettings(patch) {
  store.data.settings = { ...store.data.settings, ...patch };
  store.data.settingsT = Date.now();
  saveState();
}

// ============================================================== mail index
const META = `${LS}meta3:`;
const mail = {
  objects: new Map(),   // key -> { key, box: "in"|"sent", modified, size }
  meta: new Map(),      // key -> summary
  drafts: new Map(),    // s3 key -> draft json (+ modified)
  threadOf: new Map(),  // key -> thread id
  threads: new Map(),   // thread id -> [keys]
  loaded: false,
  loading: false,
  lastRefresh: 0,
};
const meta = (k) => mail.meta.get(k);
const boxOf = (k) => (mail.objects.get(k) || {}).box;
const dateOf = (k) => { const m = meta(k); const d = new Date(m ? m.date : (mail.objects.get(k) || {}).modified); return isNaN(d) ? new Date((mail.objects.get(k) || {}).modified || 0) : d; };
const byDate = (a, b) => dateOf(a) - dateOf(b);
const isTrash = (k) => !!F(k).trash;
const isSpam = (k) => { const f = F(k); if (f.spam === true) return true; if (f.spam === false) return false; return !!(meta(k) && meta(k).spamVerdict); }; // spam null/undefined = use SES verdict
const isUnread = (k) => boxOf(k) === "in" && !F(k).read;

function headerOf(email, name) { const x = (email.headers || []).find((hd) => hd.key === name); return x ? String(x.value) : ""; }
function flatAddrs(list) { return (list || []).flatMap((a) => (a.group ? flatAddrs(a.group) : [a])); }
function summarize(email, o) {
  const setup = o.key.endsWith("AMAZON_SES_SETUP_NOTIFICATION");
  const text = email.text || (email.html ? htmlToText(email.html) : "");
  const addrs = (list) => flatAddrs(list).map((a) => ({ name: a.name || "", address: (a.address || "").toLowerCase() })).filter((a) => a.address);
  const verdict = (n) => headerOf(email, n).trim().toUpperCase();
  return {
    subject: setup ? "Amazon SES setup notification" : email.subject || "",
    from: setup ? { name: "Amazon SES", address: "no-reply@amazonses.com" } : { name: (email.from && email.from.name) || "", address: ((email.from && email.from.address) || "").toLowerCase() },
    to: addrs(email.to), cc: addrs(email.cc), bcc: addrs(email.bcc),
    replyTo: addrs(email.replyTo)[0] || null,
    date: email.date || o.modified.toISOString(),
    snippet: text.replace(/\s+/g, " ").trim().slice(0, 200),
    spamVerdict: verdict("x-ses-spam-verdict") === "FAIL" || verdict("x-ses-virus-verdict") === "FAIL",
    messageId: cleanId(email.messageId),
    inReplyTo: cleanId(email.inReplyTo),
    references: parseRefs(headerOf(email, "references")),
    attach: (email.attachments || []).some((a) => a.disposition === "attachment" || (!a.contentId && a.filename)),
  };
}
function cacheMeta(k, m) { try { localStorage.setItem(META + k, JSON.stringify(m)); } catch { /* storage full */ } }
async function loadMeta(o) {
  const email = await PostalMime.parse(await getBytes(o.key, "bytes=0-65535")); // headers + start of body
  const m = summarize(email, o);
  cacheMeta(o.key, m);
  return m;
}

async function loadDrafts(objs) {
  const next = new Map();
  await pool(objs, 4, async (o) => {
    const prev = mail.drafts.get(o.key);
    if (prev && prev.modified >= o.modified.getTime()) { next.set(o.key, prev); return; }
    try {
      const d = JSON.parse(new TextDecoder().decode(await getBytes(o.key)));
      next.set(o.key, { ...d, key: o.key, modified: o.modified.getTime() });
    } catch (e) { if (isAuthError(e)) throw e; }
  });
  mail.drafts = next;
}

function buildThreads() {
  mail.threadOf = new Map();
  mail.threads = new Map();
  const keys = [...mail.objects.keys()];
  if (!S().conversationView) {
    for (const k of keys) { mail.threadOf.set(k, k); mail.threads.set(k, [k]); }
    return;
  }
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent.set(a, b); };
  const byId = new Map();
  for (const k of keys) {
    const m = meta(k);
    if (!m || !m.messageId) continue;
    if (byId.has(m.messageId)) { if (isSpam(k) === isSpam(byId.get(m.messageId))) union(k, byId.get(m.messageId)); } else byId.set(m.messageId, k);
  }
  for (const k of keys) {
    const m = meta(k);
    if (!m || isSpam(k)) continue; // spam may not join real conversations via forged References
    for (const id of [m.inReplyTo, ...(m.references || [])]) if (id && byId.has(id) && !isSpam(byId.get(id))) union(k, byId.get(id));
  }
  const groups = new Map();
  for (const k of keys) { const r = find(k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(k); }
  for (const ks of groups.values()) {
    ks.sort(byDate);
    const id = ks[0]; // stable id = earliest message
    mail.threads.set(id, ks);
    for (const k of ks) mail.threadOf.set(k, id);
  }
}
const threadKeys = (tid) => mail.threads.get(tid) || (mail.objects.has(tid) ? [tid] : []);

async function refresh({ silent = false } = {}) {
  if (mail.loading) return;
  mail.loading = true;
  spin(true);
  try {
    if (!silent) setStatus("Checking for mail…");
    const quick = silent && mail.loaded; // auto-refresh: 1 LIST instead of 3
    const [inbound, sent, draftObjs] = await Promise.all([
      listPrefix("emails/"),
      quick ? Promise.resolve([...mail.objects.values()].filter((o) => o.box === "sent")) : listPrefix("sent/"),
      quick ? Promise.resolve(null) : listPrefix("drafts/"),
    ]);
    const fresh = mail.loaded ? inbound.filter((o) => !mail.objects.has(o.key)) : [];
    const next = new Map();
    for (const o of inbound) next.set(o.key, { ...o, box: "in" });
    for (const o of sent) next.set(o.key, { ...o, box: "sent" });
    mail.objects = next;
    for (const k of next.keys()) {
      if (mail.meta.has(k)) continue;
      const c = localStorage.getItem(META + k);
      if (c) try { mail.meta.set(k, JSON.parse(c)); } catch { /* ignore */ }
    }
    if (draftObjs) await loadDrafts(draftObjs);
    render();

    const missing = [...next.values()].filter((o) => !mail.meta.has(o.key));
    let done = 0;
    await pool(missing, 6, async (o) => {
      try {
        mail.meta.set(o.key, await loadMeta(o));
      } catch (e) {
        if (isAuthError(e)) throw e;
        mail.meta.set(o.key, { subject: "(could not read message)", from: { name: "", address: "" }, to: [], cc: [], bcc: [], date: o.modified.toISOString(), snippet: e.message || String(e), spamVerdict: false, messageId: "", inReplyTo: "", references: [], attach: false });
      }
      if (++done % 10 === 0 || done === missing.length) { setStatus(`Loading ${done} of ${missing.length}…`); render(); }
    });
    mail.loaded = true;
    mail.lastRefresh = Date.now();
    purgeOldTrash();
    if (fresh.length) notifyNew(fresh.map((o) => o.key).filter((k) => !isSpam(k)));
    setStatus("");
    render();
  } finally {
    mail.loading = false;
    spin(false);
  }
}
function purgeOldTrash() {
  const cutoff = Date.now() - TRASH_DAYS * 86400000;
  const old = [...mail.objects.keys()].filter((k) => F(k).trash && F(k).trash < cutoff);
  if (old.length) deleteForever(old, { quiet: true });
}
function notifyNew(keys) {
  if (!keys.length) return;
  const s = S();
  if (s.notifications && "Notification" in window && Notification.permission === "granted" && document.hidden) {
    const m = meta(keys[0]);
    const n = new Notification(keys.length === 1 ? `New mail from ${nameOf(m.from)}` : `${keys.length} new messages`, { body: m ? m.subject : "", tag: "mail" });
    n.onclick = () => { window.focus(); setFolder("inbox"); openThread(mail.threadOf.get(keys[0])); n.close(); };
  }
  if (!document.hidden) toast(keys.length === 1 ? `New message from ${nameOf(meta(keys[0]).from)}` : `${keys.length} new messages`, { action: { label: "View", fn: () => { setFolder("inbox"); openThread(mail.threadOf.get(keys[0])); } } });
}

// ================================================================ folders
const ui = { folder: "inbox", addr: null, query: "", open: null, selected: new Set(), page: 1, rows: [], view: "list" };
const FOLDERS = [
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "starred", label: "Starred", icon: "star" },
  { id: "sent", label: "Sent", icon: "sent" },
  { id: "drafts", label: "Drafts", icon: "draft" },
  { id: "archive", label: "Archive", icon: "archive" },
  { id: "all", label: "All mail", icon: "all" },
  { id: "spam", label: "Spam", icon: "spam" },
  { id: "trash", label: "Trash", icon: "trash" },
];
const PRED = {
  inbox: (k) => boxOf(k) === "in" && !isTrash(k) && !isSpam(k) && !F(k).arch,
  starred: (k) => !!F(k).star && !isTrash(k),
  sent: (k) => boxOf(k) === "sent" && !isTrash(k),
  archive: (k) => boxOf(k) === "in" && !!F(k).arch && !isTrash(k) && !isSpam(k),
  all: (k) => !isTrash(k) && !isSpam(k),
  spam: (k) => boxOf(k) === "in" && isSpam(k) && !isTrash(k),
  trash: (k) => isTrash(k),
};
function parseQuery(q) {
  const t = { text: [], from: [], to: [], subject: [], has: [], is: [] };
  for (const tok of q.match(/(\w+:"[^"]*"|\w+:\S+|"[^"]*"|\S+)/g) || []) {
    const m = tok.match(/^(from|to|subject|has|is):(.*)$/i);
    if (m) t[m[1].toLowerCase()].push(m[2].replace(/^"|"$/g, "").toLowerCase());
    else t.text.push(tok.replace(/^"|"$/g, "").toLowerCase());
  }
  return t;
}
function matchQuery(k, t) {
  const m = meta(k);
  if (!m) return false;
  const from = `${m.from.name} ${m.from.address}`.toLowerCase();
  const to = [...m.to, ...m.cc].map((a) => `${a.name} ${a.address}`).join(" ").toLowerCase();
  const subject = m.subject.toLowerCase();
  const all = `${from} ${to} ${subject} ${m.snippet.toLowerCase()}`;
  return t.text.every((x) => all.includes(x)) && t.from.every((x) => from.includes(x)) && t.to.every((x) => to.includes(x)) &&
    t.subject.every((x) => subject.includes(x)) && t.has.every((x) => (x.startsWith("attach") ? m.attach : true)) &&
    t.is.every((x) => (x === "unread" ? isUnread(k) : x === "read" ? !isUnread(k) : x === "starred" ? !!F(k).star : true));
}
function currentPredicate() {
  if (ui.query) { const t = parseQuery(ui.query); return (k) => !isTrash(k) && !isSpam(k) && matchQuery(k, t); }
  if (ui.addr) return (k) => boxOf(k) === "in" && !isTrash(k) && !isSpam(k) && meta(k) && [...meta(k).to, ...meta(k).cc].some((a) => a.address === ui.addr);
  return PRED[ui.folder] || PRED.inbox;
}
function folderRows() {
  const pred = currentPredicate();
  const groups = new Map();
  for (const k of mail.objects.keys()) {
    if (!pred(k)) continue;
    const t = mail.threadOf.get(k) || k;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(k);
  }
  const rows = [];
  for (const [tid, keys] of groups) {
    keys.sort(byDate);
    const visible = threadKeys(tid).filter((k) => (ui.folder === "trash" && !ui.query ? isTrash(k) : !isTrash(k)));
    rows.push({ tid, keys, latest: keys[keys.length - 1], all: visible, unread: keys.some(isUnread), star: visible.some((k) => F(k).star), attach: visible.some((k) => meta(k) && meta(k).attach) });
  }
  rows.sort((a, b) => dateOf(b.latest) - dateOf(a.latest));
  return rows;
}
const unreadCount = (pred) => { const t = new Set(); for (const k of mail.objects.keys()) if (pred(k) && isUnread(k)) t.add(mail.threadOf.get(k) || k); return t.size; };
function knownAddresses() {
  const set = new Map();
  for (const k of mail.objects.keys()) {
    const m = meta(k);
    if (!m || boxOf(k) !== "in" || isSpam(k)) continue;
    for (const a of [...m.to, ...m.cc]) if (isMine(a.address)) set.set(a.address, (set.get(a.address) || 0) + 1);
  }
  return [...set.keys()].sort();
}
function contacts() {
  const map = new Map();
  for (const k of mail.objects.keys()) {
    const m = meta(k);
    if (!m || isSpam(k)) continue;
    for (const a of [m.from, ...m.to, ...m.cc]) {
      if (!a || !a.address || !EMAIL_RE.test(a.address) || /no-?reply|mailer-daemon/i.test(a.address)) continue;
      const c = map.get(a.address) || { address: a.address, name: "", n: 0 };
      c.n += boxOf(k) === "sent" ? 3 : 1;
      if (a.name && !c.name) c.name = a.name;
      map.set(a.address, c);
    }
  }
  return [...map.values()].sort((a, b) => b.n - a.n);
}

// ============================================================== rendering
const setStatus = (t) => { $("status").textContent = t; };
const spin = (on) => { const b = $("refresh-btn"); b.disabled = on; b.firstChild && b.firstChild.classList && b.firstChild.classList.toggle("animate-spin", on); };
const panes = { boxes: $("pane-boxes"), list: $("pane-list"), reader: $("pane-reader") };
function setView(v) {
  ui.view = v;
  for (const [k, el] of Object.entries(panes)) { el.classList.toggle("hidden", k !== v); el.classList.toggle("flex", k === v); }
}
function setFolder(id, addr = null) {
  ui.folder = id;
  ui.addr = addr;
  ui.query = "";
  $("search").value = "";
  ui.selected.clear();
  ui.page = 1;
  ui.open = null;
  render();
  emptyReader();
  setView("list");
}
function render() {
  buildThreads();
  renderBoxes();
  renderToolbar();
  renderList();
  const n = unreadCount(PRED.inbox);
  const folder = ui.query ? "Search" : ui.addr ? ui.addr : (FOLDERS.find((f) => f.id === ui.folder) || {}).label;
  document.title = `${n ? `(${n}) ` : ""}${folder} · ${DOMAIN} Mail`;
}
function renderBoxes() {
  const item = (id, label, ic, count, onclick, active) => h("button", {
    class: `group flex w-full items-center gap-3 rounded-r-full px-4 py-1.5 text-left text-sm ${active ? "bg-blue-100 font-semibold text-blue-900 dark:bg-blue-900/50 dark:text-blue-100" : "text-slate-700 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-800"}`,
    onclick,
  }, icon(ic, "h-5 w-5 shrink-0"), h("span", { class: "min-w-0 flex-1 truncate" }, label), count ? h("span", { class: "text-xs font-semibold" }, count) : null);
  const counts = { inbox: unreadCount(PRED.inbox), spam: unreadCount(PRED.spam), drafts: mail.drafts.size };
  const nodes = FOLDERS.map((f) => item(f.id, f.label, f.icon, counts[f.id] || 0, () => setFolder(f.id), !ui.query && !ui.addr && ui.folder === f.id));
  const addrs = knownAddresses();
  if (addrs.length) {
    nodes.push(h("div", { class: "px-4 pb-1 pt-5 text-xs font-semibold uppercase tracking-wide text-slate-400" }, "Addresses"));
    for (const a of addrs) {
      const pred = (k) => boxOf(k) === "in" && !isTrash(k) && !isSpam(k) && meta(k) && [...meta(k).to, ...meta(k).cc].some((x) => x.address === a);
      nodes.push(item("addr", a.split("@")[0], "at", unreadCount(pred), () => setFolder("inbox", a), !ui.query && ui.addr === a));
    }
  }
  $("boxes").replaceChildren(...nodes);
}

function selectedKeys() {
  return ui.rows.filter((r) => ui.selected.has(r.tid)).flatMap((r) => r.keys);
}
function renderToolbar() {
  const bar = $("list-toolbar");
  if (ui.folder === "drafts" && !ui.query && !ui.addr) {
    bar.replaceChildren(h("span", { class: "px-2 text-sm font-semibold" }, "Drafts"), h("span", { class: "ml-auto pr-2 text-xs text-slate-500" }, plural(mail.drafts.size, "draft")));
    return;
  }
  const rows = ui.rows;
  const all = rows.length > 0 && rows.every((r) => ui.selected.has(r.tid));
  const some = ui.selected.size > 0;
  const cb = h("input", { type: "checkbox", class: "ml-2 mr-1 h-4 w-4 rounded", title: "Select all", checked: all, onchange: (e) => { ui.selected = e.target.checked ? new Set(rows.map((r) => r.tid)) : new Set(); render(); } });
  cb.indeterminate = some && !all;
  const items = [cb];
  if (some) {
    const keys = () => selectedKeys();
    const done = () => { ui.selected.clear(); };
    if (ui.folder === "trash" && !ui.query) {
      items.push(iconBtn("inbox", "Restore", () => { setFlags(keys(), { trash: 0 }, "Restored"); done(); }));
      items.push(iconBtn("trash", "Delete forever", () => { deleteForever(keys()); done(); }));
    } else {
      if (ui.folder === "archive") items.push(iconBtn("inbox", "Move to inbox", () => { setFlags(keys(), { arch: false }, "Moved to inbox"); done(); }));
      else items.push(iconBtn("archive", "Archive (e)", () => { setFlags(keys(), { arch: true }, "Archived"); done(); }));
      if (ui.folder === "spam") items.push(iconBtn("inbox", "Not spam", () => { setFlags(keys(), { spam: false, arch: false }, "Moved to inbox"); done(); }));
      else items.push(iconBtn("spam", "Report spam", () => { setFlags(keys(), { spam: true }, "Marked as spam"); done(); }));
      items.push(iconBtn("trash", "Delete (#)", () => { setFlags(keys(), { trash: Date.now() }, "Moved to Trash"); done(); }));
    }
    const anyUnread = keys().some(isUnread);
    items.push(h("span", { class: "mx-1 h-5 border-l border-slate-200 dark:border-slate-700" }));
    items.push(anyUnread ? iconBtn("read", "Mark as read", () => { setFlags(keys(), { read: true }); done(); }) : iconBtn("unread", "Mark as unread", () => { setFlags(keys(), { read: false }); done(); }));
    items.push(h("span", { class: "ml-auto pr-3 text-xs text-slate-500" }, `${ui.selected.size} selected`));
  } else {
    items.push(iconBtn("refresh", "Refresh", () => refresh().catch(handleError)));
    const title = ui.query ? `Results for “${ui.query}”` : ui.addr ? ui.addr : "";
    if (title) items.push(h("span", { class: "truncate px-2 text-sm font-medium" }, title));
    if (ui.folder === "trash" && !ui.query && rows.length) items.push(h("button", { class: "btn-ghost ml-2 text-xs text-red-600", onclick: emptyTrash }, "Empty trash"));
    if (ui.folder === "spam" && !ui.query && rows.length) items.push(h("button", { class: "btn-ghost ml-2 text-xs text-red-600", onclick: () => deleteForever(rows.flatMap((r) => r.keys)) }, "Delete all spam"));
    items.push(h("span", { class: "ml-auto pr-3 text-xs text-slate-500" }, rows.length ? `${Math.min(rows.length, ui.page * 50)} of ${rows.length}` : ""));
  }
  bar.replaceChildren(...items);
}
function senderLine(row) {
  if (ui.folder === "sent" && !ui.query) {
    const m = meta(row.latest);
    return m ? `To: ${[...m.to, ...m.cc].map(shortName).join(", ") || "(no recipients)"}` : "";
  }
  const names = [];
  for (const k of row.all) { const m = meta(k); if (!m) continue; const n = shortName(boxOf(k) === "sent" ? { address: `me@${DOMAIN}` } : m.from); if (!names.includes(n)) names.push(n); }
  return names.slice(-3).join(", ") || "(unknown sender)";
}
function renderList() {
  const list = $("list");
  if (ui.folder === "drafts" && !ui.query && !ui.addr) return renderDrafts();
  const rows = folderRows();
  ui.rows = rows;
  for (const tid of [...ui.selected]) if (!rows.some((r) => r.tid === tid)) ui.selected.delete(tid);
  if (!rows.length) {
    const empty = { inbox: "Your inbox is empty", spam: "No spam here", trash: "Trash is empty", starred: "No starred messages", sent: "Nothing sent yet", archive: "Nothing archived" };
    list.replaceChildren(h("li", { class: "flex flex-col items-center gap-2 p-10 text-center text-sm text-slate-500" },
      icon(ui.query ? "search" : (FOLDERS.find((f) => f.id === ui.folder) || {}).icon || "inbox", "h-10 w-10 opacity-40"),
      !mail.loaded ? "Loading your mail…" : ui.query ? "No messages match your search" : empty[ui.folder] || "No messages"));
    renderToolbar();
    return;
  }
  const shown = rows.slice(0, ui.page * 50);
  const els = shown.map((row) => {
    const m = meta(row.latest);
    const active = ui.open === row.tid;
    const sel = ui.selected.has(row.tid);
    const count = row.all.length > 1 ? h("span", { class: "text-xs text-slate-500" }, ` ${row.all.length}`) : null;
    const hover = h("div", { class: "hidden items-center gap-0.5 group-hover:flex" },
      ui.folder !== "trash" ? iconBtn("archive", "Archive", (e) => { e.stopPropagation(); setFlags(row.keys, { arch: true }, "Archived"); }, "h-7 w-7") : null,
      ui.folder !== "trash" ? iconBtn("trash", "Delete", (e) => { e.stopPropagation(); setFlags(row.keys, { trash: Date.now() }, "Moved to Trash"); }, "h-7 w-7") : null,
      iconBtn(row.unread ? "read" : "unread", row.unread ? "Mark as read" : "Mark as unread", (e) => { e.stopPropagation(); setFlags(row.keys, { read: row.unread }); }, "h-7 w-7"));
    return h("li", {
      class: `group relative flex cursor-pointer items-start gap-2 border-b border-slate-100 px-2 py-2.5 dark:border-slate-800 ${active ? "bg-blue-50 dark:bg-blue-950/60" : sel ? "bg-blue-50/60 dark:bg-blue-950/40" : row.unread ? "bg-white dark:bg-slate-900" : "bg-slate-50/60 dark:bg-slate-900/60"} hover:shadow-[inset_0_-1px_0_#e2e8f0,0_1px_3px_rgba(0,0,0,.08)]`,
      onclick: () => openThread(row.tid),
      dataset: { tid: row.tid },
    },
      h("div", { class: "flex shrink-0 flex-col items-center gap-1 pt-0.5" },
        h("input", { type: "checkbox", class: "h-4 w-4 rounded", checked: sel, onclick: (e) => e.stopPropagation(), onchange: (e) => { if (e.target.checked) ui.selected.add(row.tid); else ui.selected.delete(row.tid); render(); } }),
        h("button", { class: `${row.star ? "text-amber-400" : "text-slate-300 hover:text-slate-500 dark:text-slate-600"}`, title: row.star ? "Unstar" : "Star", onclick: (e) => { e.stopPropagation(); toggleStar(row); } }, icon("star", "h-4 w-4", row.star))),
      h("div", { class: "min-w-0 flex-1" },
        h("div", { class: "flex items-center gap-2" },
          row.unread ? h("span", { class: "h-2 w-2 shrink-0 rounded-full bg-blue-600" }) : null,
          h("span", { class: `min-w-0 flex-1 truncate text-sm ${row.unread ? "font-bold text-slate-900 dark:text-white" : "text-slate-700 dark:text-slate-300"}` }, m ? senderLine(row) : "Loading…", count),
          row.attach ? icon("clip", "h-4 w-4 shrink-0 text-slate-400") : null,
          h("span", { class: `shrink-0 text-xs group-hover:hidden ${row.unread ? "font-bold text-slate-900 dark:text-white" : "text-slate-500"}` }, fmtDate(dateOf(row.latest))),
          hover),
        h("div", { class: `truncate text-sm ${row.unread ? "font-semibold text-slate-900 dark:text-white" : "text-slate-700 dark:text-slate-300"}` }, m ? m.subject || "(no subject)" : ""),
        h("div", { class: "truncate text-xs text-slate-500" }, m ? m.snippet : "")));
  });
  if (rows.length > shown.length) els.push(h("li", { class: "p-3 text-center" }, h("button", { class: "btn-ghost", onclick: () => { ui.page++; renderList(); } }, `Load more (${rows.length - shown.length})`)));
  list.replaceChildren(...els);
  renderToolbar();
}
function renderDrafts() {
  const drafts = [...mail.drafts.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  ui.rows = [];
  if (!drafts.length) {
    $("list").replaceChildren(h("li", { class: "flex flex-col items-center gap-2 p-10 text-center text-sm text-slate-500" }, icon("draft", "h-10 w-10 opacity-40"), "No drafts"));
    return;
  }
  $("list").replaceChildren(...drafts.map((d) => h("li", {
    class: "group flex cursor-pointer items-start gap-3 border-b border-slate-100 px-4 py-3 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60",
    onclick: () => openCompose({ draft: d }),
  },
    h("div", { class: "min-w-0 flex-1" },
      h("div", { class: "flex items-center gap-2" },
        h("span", { class: "text-sm font-semibold text-red-600" }, "Draft"),
        h("span", { class: "min-w-0 flex-1 truncate text-sm" }, (d.to || []).map(nameOf).join(", ") || "(no recipients)"),
        h("span", { class: "shrink-0 text-xs text-slate-500" }, fmtDate(d.updated || d.modified))),
      h("div", { class: "truncate text-sm" }, d.subject || "(no subject)"),
      h("div", { class: "truncate text-xs text-slate-500" }, htmlToText(d.html || "").slice(0, 160))),
    iconBtn("trash", "Discard draft", async (e) => { e.stopPropagation(); await discardDraftKey(d.key); }, "h-7 w-7 opacity-0 group-hover:opacity-100"))));
}
function toggleStar(row) {
  if (row.star) setFlags(row.all.filter((k) => F(k).star), { star: false });
  else setFlags([row.latest], { star: true });
}
async function deleteForever(keys, { quiet = false } = {}) {
  keys = [...new Set(keys)];
  if (!keys.length) return;
  if (!quiet && !confirm(`Permanently delete ${plural(keys.length, "message")}? This can't be undone.`)) return;
  let failed = 0;
  await pool(keys, 4, async (k) => {
    try {
      await deleteObject(k);
      mail.objects.delete(k);
      mail.meta.delete(k);
      delete store.data.msgs[k];
      store.deleted.add(k);
      localStorage.removeItem(META + k);
    } catch (e) { if (isAuthError(e)) throw e; failed++; }
  }).catch(handleError);
  saveState();
  if (ui.open && !threadKeys(ui.open).length) { ui.open = null; emptyReader(); }
  render();
  if (!quiet) toast(failed ? `Deleted with ${failed} error(s)` : `Deleted ${plural(keys.length - failed, "message")} forever`);
}
function emptyTrash() { deleteForever([...mail.objects.keys()].filter(isTrash)); }

// ============================================================ reading pane
const rawCache = new Map(); // key -> { raw, email }
async function loadFull(key) {
  if (rawCache.has(key)) return rawCache.get(key);
  const raw = await getBytes(key);
  const email = await PostalMime.parse(raw);
  rawCache.set(key, { raw, email });
  if (rawCache.size > 40) rawCache.delete(rawCache.keys().next().value);
  return { raw, email };
}
function emptyReader() {
  $("reader").replaceChildren(h("div", { class: "m-auto flex flex-col items-center gap-3 p-6 text-sm text-slate-400" }, icon("unread", "h-14 w-14 opacity-40"), "Select a conversation to read"));
}
const isDarkUI = () => document.documentElement.classList.contains("dark");
// "Designed" emails set their own colours/layout; recolouring them breaks them, so they stay light.
const isDesigned = (html) => /bgcolor\s*=|background(-color)?\s*:|<table|\scolor\s*=|[^-]color\s*:/i.test(html || "");
function srcdoc(html, allowRemote, dark = false) {
  const ext = allowRemote ? " https: http:" : "";
  const csp = `default-src 'none'; img-src data:${ext}; style-src 'unsafe-inline'${ext}; font-src data:${ext}; media-src data:${ext}`;
  const clean = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<meta name="referrer" content="no-referrer"><base target="_blank">` +
    `<style>html{color-scheme:${dark ? "dark" : "light"};background:transparent}body{margin:0;padding:0;font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:${dark ? "#e2e8f0" : "#1e293b"};background:transparent;overflow-wrap:anywhere}` +
    `img{max-width:100%;height:auto}a{color:${dark ? "#60a5fa" : "#2563eb"}}blockquote{margin:.25em 0 0 .25em;padding-left:.75em;border-left:2px solid ${dark ? "#475569" : "#cbd5e1"};color:${dark ? "#94a3b8" : "#475569"}}</style>` +
    `</head><body>${clean}</body></html>`;
}
function inlineCid(html, atts) {
  const byId = new Map();
  for (const a of atts || []) if (a.contentId) byId.set(cleanId(a.contentId).toLowerCase(), a);
  if (!byId.size) return html;
  return html.replace(/cid:([^"'\s)>]+)/gi, (whole, id) => {
    let a;
    try { a = byId.get(decodeURIComponent(id).toLowerCase()); } catch { return whole; }
    return a && /^image\/[\w.+-]+$/i.test(a.mimeType) ? `data:${a.mimeType};base64,${b64(a.content)}` : whole;
  });
}
const hasRemote = (html) => /(src|background)\s*=\s*["']?\s*https?:|url\(\s*["']?https?:/i.test(html || "");
function bodyFrame(html, allowRemote, dark = false) {
  // sandbox WITHOUT allow-scripts: email can never run code. allow-same-origin only lets us measure height.
  const frame = h("iframe", { class: "block w-full border-0", sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox", referrerpolicy: "no-referrer", title: "Message body", style: "height:80px" });
  frame.srcdoc = srcdoc(html, allowRemote, dark);
  let fitCount = 0;
  const fit = () => {
    try {
      const d = frame.contentDocument;
      if (!d || !d.body) return;
      const r = d.createRange();
      r.selectNodeContents(d.body);
      const kids = [...d.body.children];
      const bottom = Math.max(r.getBoundingClientRect().bottom, ...kids.map((el) => el.getBoundingClientRect().bottom + parseFloat(getComputedStyle(el).marginBottom || 0)));
      const want = Math.min(20000, Math.ceil(Math.max(24, bottom + 4, d.body.scrollHeight > frame.clientHeight ? d.body.scrollHeight : 0)));
      const have = parseFloat(frame.style.height) || 0;
      if (Math.abs(want - have) > 2 && fitCount++ < 40) frame.style.height = `${want}px`;
    } catch { /* ignore */ }
  };
  frame.addEventListener("load", () => {
    try {
      const d = frame.contentDocument;
      d.querySelectorAll("a[href]").forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
      d.querySelectorAll("img").forEach((i) => i.addEventListener("load", fit));
      new ResizeObserver(fit).observe(d.body);
    } catch { /* ignore */ }
    fit();
  });
  return frame;
}
function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g)) {
    out.push(text.slice(last, m.index));
    out.push(h("a", { href: m[0], target: "_blank", rel: "noopener noreferrer", class: "text-blue-600 underline dark:text-blue-400" }, m[0]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function threadForReader(tid) {
  const inTrash = ui.folder === "trash" && !ui.query && !ui.addr;
  const inSpam = ui.folder === "spam" && !ui.query && !ui.addr;
  const keys = threadKeys(tid).filter((k) => (inTrash ? isTrash(k) : !isTrash(k) && (inSpam ? isSpam(k) : !isSpam(k))));
  return keys.sort(byDate);
}
async function openThread(tid) {
  if (!tid) return;
  ui.open = tid;
  const keys = threadForReader(tid);
  if (!keys.length) { emptyReader(); return; }
  const unread = keys.filter(isUnread);
  if (unread.length) setFlags(unread, { read: true }); else render();
  setView("reader");
  renderReader(tid, keys, new Set([...unread, keys[keys.length - 1]]));
}
function renderReader(tid, keys, expanded) {
  const m0 = meta(keys[keys.length - 1]) || {};
  const subject = (meta(keys[0]) || m0).subject || "(no subject)";
  const inTrash = keys.every(isTrash);
  const spam = keys.some(isSpam);
  const arch = keys.every((k) => boxOf(k) !== "in" || F(k).arch);
  const starred = keys.some((k) => F(k).star);
  const after = () => { const i = ui.rows.findIndex((r) => r.tid === tid); const next = ui.rows[i + 1] || ui.rows[i - 1]; ui.open = null; if (next && next.tid !== tid) openThread(next.tid); else { emptyReader(); setView("list"); } };
  const tools = h("div", { class: "flex h-12 shrink-0 items-center gap-1 border-b border-slate-200 px-3 dark:border-slate-800 print:hidden" },
    iconBtn("back", "Back to list (u)", () => { ui.open = null; render(); emptyReader(); setView("list"); }),
    inTrash
      ? [iconBtn("inbox", "Restore", () => { setFlags(keys, { trash: 0 }, "Restored"); after(); }), iconBtn("trash", "Delete forever", () => { deleteForever(keys); })]
      : [
        arch ? iconBtn("inbox", "Move to inbox", () => { setFlags(keys, { arch: false }, "Moved to inbox"); after(); }) : iconBtn("archive", "Archive (e)", () => { setFlags(keys, { arch: true }, "Archived"); after(); }),
        spam ? iconBtn("inbox", "Not spam", () => { setFlags(keys, { spam: false, arch: false }, "Moved to inbox"); after(); }) : iconBtn("spam", "Report spam", () => { setFlags(keys, { spam: true }, "Marked as spam"); after(); }),
        iconBtn("trash", "Delete (#)", () => { setFlags(keys, { trash: Date.now() }, "Moved to Trash"); after(); }),
      ],
    h("span", { class: "mx-1 h-5 border-l border-slate-200 dark:border-slate-700" }),
    iconBtn("unread", "Mark as unread (Shift+U)", () => { setFlags(keys.filter((k) => boxOf(k) === "in").slice(-1), { read: false }); ui.open = null; render(); emptyReader(); setView("list"); }),
    h("button", { class: `icon-btn ${starred ? "text-amber-400" : ""}`, title: starred ? "Unstar (s)" : "Star (s)", onclick: () => { setFlags(starred ? keys.filter((k) => F(k).star) : [keys[keys.length - 1]], { star: !starred }); renderReader(tid, keys, expanded); } }, icon("star", "h-5 w-5", starred)),
    h("span", { class: "ml-auto" }),
    iconBtn("print", "Print", () => { expandAll(); setTimeout(() => window.print(), 400); }),
    keys.length > 1 ? iconBtn("expand", "Expand all", () => expandAll()) : null);
  const list = h("div", { class: "mx-auto w-full max-w-4xl space-y-3 px-4 pb-10 pt-4 md:px-8" });
  const cards = keys.map((k, i) => messageCard(k, expanded.has(k), i === keys.length - 1));
  const expandAll = () => cards.forEach((c) => c.expand());
  append(list, cards.map((c) => c.el));
  const last = keys[keys.length - 1];
  list.append(h("div", { class: "flex flex-wrap gap-2 pt-2 print:hidden" },
    h("button", { class: "btn rounded-full border border-slate-300 px-5 hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800", onclick: () => startReply(last, "reply") }, icon("reply", "h-4 w-4"), "Reply"),
    h("button", { class: "btn rounded-full border border-slate-300 px-5 hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800", onclick: () => startReply(last, "replyAll") }, icon("replyAll", "h-4 w-4"), "Reply all"),
    h("button", { class: "btn rounded-full border border-slate-300 px-5 hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800", onclick: () => startReply(last, "forward") }, icon("forward", "h-4 w-4"), "Forward")));
  const scroller = h("div", { class: "min-h-0 flex-1 overflow-y-auto" },
    h("div", { class: "mx-auto w-full max-w-4xl px-4 pt-5 md:px-8" },
      h("h1", { class: "text-xl font-normal leading-snug text-slate-900 dark:text-white" }, subject,
        spam ? h("span", { class: "ml-2 rounded bg-red-100 px-1.5 py-0.5 align-middle text-xs font-medium text-red-700" }, "Spam") : null,
        inTrash ? h("span", { class: "ml-2 rounded bg-slate-200 px-1.5 py-0.5 align-middle text-xs font-medium text-slate-700" }, "Trash") : null)),
    list);
  $("reader").replaceChildren(tools, scroller);
}

function messageCard(key, startExpanded, isLast) {
  const m = meta(key) || { from: { name: "", address: "" }, to: [], cc: [], subject: "", snippet: "" };
  const mine = boxOf(key) === "sent";
  const el = h("div", { class: "rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900" });
  let expanded = false;
  const collapsed = () => h("button", { class: "flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60", onclick: () => expand() },
    avatar(m.from, "h-8 w-8 text-xs"),
    h("span", { class: "w-40 shrink-0 truncate text-sm font-semibold" }, mine ? "me" : nameOf(m.from)),
    h("span", { class: "min-w-0 flex-1 truncate text-sm text-slate-500" }, m.snippet),
    h("span", { class: "shrink-0 text-xs text-slate-500" }, fmtDate(dateOf(key))));
  async function expand() {
    if (expanded) return;
    expanded = true;
    el.replaceChildren(h("div", { class: "flex items-center gap-3 px-4 py-4 text-sm text-slate-500" }, avatar(m.from, "h-10 w-10"), "Loading message…"));
    try {
      const { raw, email } = await loadFull(key);
      el.replaceChildren(...fullMessage(key, raw, email, m, mine, () => { expanded = false; el.replaceChildren(collapsed()); }));
    } catch (e) {
      if (isAuthError(e)) return handleError(e);
      el.replaceChildren(h("div", { class: "p-4 text-sm text-red-600" }, `Could not open this message: ${e.message || e}`));
    }
  }
  if (startExpanded) expand(); else el.append(collapsed());
  return { el, expand };
}

function fullMessage(key, raw, email, m, mine, collapse) {
  const s = S();
  const from = email.from || m.from;
  const sender = ((from && from.address) || "").toLowerCase();
  let allowRemote = s.remoteImages === "always" || s.trustedSenders.includes(sender) || mine;
  const used = (a) => a.contentId && email.html && email.html.includes(cleanId(a.contentId));
  const files = (email.attachments || []).filter((a) => !used(a));
  const body = h("div", { class: "px-4 pb-4 md:pl-16" });
  const drawBody = () => {
    const parts = [];
    if (email.html && hasRemote(email.html) && !allowRemote) {
      parts.push(h("div", { class: "mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300 print:hidden" },
        icon("photo", "h-4 w-4"), "Images are hidden to protect your privacy.",
        h("button", { class: "font-semibold text-blue-600 hover:underline dark:text-blue-400", onclick: () => { allowRemote = true; drawBody(); } }, "Show images"),
        sender ? h("button", { class: "font-semibold text-blue-600 hover:underline dark:text-blue-400", onclick: () => { setSettings({ trustedSenders: [...new Set([...S().trustedSenders, sender])] }); allowRemote = true; drawBody(); } }, `Always show from ${sender}`) : null));
    }
    if (email.html) {
      const dark = isDarkUI() && !isDesigned(email.html);
      parts.push(h("div", { class: dark ? "py-1" : "overflow-hidden rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:ring-slate-700" },
        bodyFrame(inlineCid(email.html, email.attachments), allowRemote, dark)));
    }
    else parts.push(h("div", { class: "whitespace-pre-wrap break-words text-sm leading-relaxed" }, linkify(email.text || "(empty message)")));
    if (files.length) {
      parts.push(h("div", { class: "mt-4 border-t border-slate-100 pt-3 dark:border-slate-800" },
        h("div", { class: "mb-2 text-xs font-semibold text-slate-500" }, plural(files.length, "attachment")),
        h("div", { class: "flex flex-wrap gap-2" }, files.map((a) => attachmentCard(a)))));
    }
    body.replaceChildren(...parts);
  };
  drawBody();
  const recipients = [...(email.to ? flatAddrs(email.to) : m.to)].map(shortName).join(", ");
  const details = h("div", { class: "mt-1 hidden rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-700" },
    ...[["from", fmtAddr(from)], ["to", flatAddrs(email.to).map(fmtAddr).join(", ")], ["cc", flatAddrs(email.cc).map(fmtAddr).join(", ")], ["bcc", flatAddrs(email.bcc).map(fmtAddr).join(", ")],
      ["reply-to", flatAddrs(email.replyTo).map(fmtAddr).join(", ")], ["date", fmtFull(email.date || dateOf(key))], ["subject", email.subject || ""]]
      .filter(([, v]) => v).map(([k, v]) => h("div", { class: "flex gap-2 py-0.5" }, h("span", { class: "w-16 shrink-0 text-right text-slate-500" }, `${k}:`), h("span", { class: "min-w-0 break-words" }, v))));
  const more = (e) => showMenu(e.currentTarget, [
    { label: "Reply", icon: "reply", onClick: () => startReply(key, "reply") },
    { label: "Reply all", icon: "replyAll", onClick: () => startReply(key, "replyAll") },
    { label: "Forward", icon: "forward", onClick: () => startReply(key, "forward") },
    "-",
    boxOf(key) === "in" ? { label: "Mark unread from here", icon: "unread", onClick: () => { setFlags([key], { read: false }); } } : null,
    { label: "Download message (.eml)", icon: "download", onClick: () => saveBlob(raw, `${(email.subject || "message").replace(/[^\w .-]+/g, "_").slice(0, 80)}.eml`) },
    { label: "Show original", icon: "code", onClick: () => showOriginal(raw) },
    "-",
    { label: "Delete this message", icon: "trash", danger: true, onClick: () => { setFlags([key], { trash: Date.now() }, "Moved to Trash"); if (ui.open) openThread(ui.open); } },
  ]);
  const when = dateOf(key);
  const head = h("div", { class: "flex items-start gap-3 px-4 pt-4" },
    avatar(from, "h-10 w-10"),
    h("div", { class: "min-w-0 flex-1" },
      h("div", { class: "flex flex-wrap items-baseline gap-x-2 cursor-pointer", onclick: collapse },
        h("span", { class: "text-sm font-semibold" }, mine ? (from.name || "me") : nameOf(from)),
        h("span", { class: "truncate text-xs text-slate-500" }, `<${(from && from.address) || ""}>`)),
      h("button", { class: "inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200", onclick: () => details.classList.toggle("hidden") },
        `to ${recipients || "(undisclosed)"}`, icon("down", "h-3 w-3")),
      details),
    h("div", { class: "flex shrink-0 items-center gap-1" },
      h("span", { class: "hidden text-xs text-slate-500 sm:inline", title: fmtFull(when) }, `${fmtFull(when)}${relTime(when) ? ` (${relTime(when)})` : ""}`),
      iconBtn("reply", "Reply (r)", () => startReply(key, "reply"), "print:hidden"),
      h("button", { class: "icon-btn print:hidden", title: "More", onclick: more }, icon("dots"))));
  return [head, body];
}
function attachmentCard(a) {
  const isImg = /^image\/(png|jpe?g|gif|webp)$/i.test(a.mimeType || "");
  const size = a.content ? a.content.byteLength : 0;
  const name = a.filename || "attachment";
  return h("div", { class: "group flex w-56 items-center gap-2 rounded-lg border border-slate-200 p-2 dark:border-slate-700" },
    h("span", { class: "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded bg-slate-100 text-slate-500 dark:bg-slate-800" }, icon(isImg ? "photo" : "file", "h-5 w-5")),
    h("div", { class: "min-w-0 flex-1" }, h("div", { class: "truncate text-xs font-medium", title: name }, name), h("div", { class: "text-xs text-slate-500" }, fmtSize(size))),
    isImg ? iconBtn("eye", "Preview", () => previewImage(a), "h-7 w-7") : null,
    iconBtn("download", "Download", () => saveBlob(a.content, name), "h-7 w-7"));
}
function previewImage(a) {
  const url = URL.createObjectURL(new Blob([a.content], { type: a.mimeType }));
  const dlg = $("lightbox");
  dlg.replaceChildren(h("img", { src: url, alt: a.filename || "", class: "max-h-[88vh] max-w-[88vw] object-contain" }));
  dlg.onclose = () => URL.revokeObjectURL(url);
  dlg.onclick = () => dlg.close();
  dlg.showModal();
}
function showOriginal(raw) {
  const dlg = $("lightbox");
  dlg.replaceChildren(h("div", { class: "flex max-h-[88vh] w-[min(90vw,64rem)] flex-col bg-white text-slate-800 dark:bg-slate-900 dark:text-slate-100" },
    h("div", { class: "flex items-center border-b border-slate-200 px-4 py-2 dark:border-slate-700" }, h("span", { class: "font-semibold" }, "Original message"), h("span", { class: "ml-auto" }), iconBtn("x", "Close", () => dlg.close())),
    h("pre", { class: "min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-xs" }, new TextDecoder().decode(raw.subarray(0, 1000000)))));
  dlg.onclick = null;
  dlg.onclose = null;
  dlg.showModal();
}

// ================================================================ compose
const composers = [];
function fromOptions() {
  const s = S();
  const list = new Map();
  for (const a of s.aliases) list.set(a.address, a.name);
  for (const a of knownAddresses()) if (!list.has(a)) list.set(a, "");
  if (!list.has(s.defaultFrom)) list.set(s.defaultFrom, "");
  return [...list.entries()].map(([address, name]) => ({ address, name }));
}
function senderFor(address) {
  const s = S();
  const alias = s.aliases.find((a) => a.address === address);
  return { address, name: (alias && alias.name) || s.displayName || "" };
}
function signatureHtml() {
  const sig = S().signature;
  return sig ? `<div><br></div><div class="signature">-- <br>${sanitize(sig)}</div>` : "";
}

async function startReply(key, mode) {
  try {
    const { email } = await loadFull(key);
    const m = meta(key) || {};
    const mine = boxOf(key) === "sent";
    const addrs = (l) => flatAddrs(l).map((a) => ({ name: a.name || "", address: (a.address || "").toLowerCase() })).filter((a) => a.address);
    const fromA = addrs(email.from ? [email.from] : [])[0];
    const replyTo = addrs(email.replyTo);
    let to = [], cc = [];
    const senderList = fromA ? [fromA] : [];
    if (mode === "reply") to = mine ? addrs(email.to) : (replyTo.length ? replyTo : senderList);
    if (mode === "replyAll") {
      to = mine ? addrs(email.to) : [...(replyTo.length ? replyTo : senderList), ...addrs(email.to)];
      cc = addrs(email.cc);
      const seen = new Set();
      const keep = (a) => a && !isMine(a.address) && !seen.has(a.address) && seen.add(a.address);
      to = to.filter(keep);
      cc = cc.filter(keep);
      if (!to.length && mine) to = addrs(email.to);
    }
    const mineAddr = [...addrs(email.to), ...addrs(email.cc)].map((a) => a.address).find(isMine);
    const from = mine ? ((fromA && fromA.address) || S().defaultFrom) : mineAddr || S().defaultFrom;
    const subj = email.subject || "";
    const subject = mode === "forward" ? (/^fwd?:/i.test(subj) ? subj : `Fwd: ${subj}`) : (/^re:/i.test(subj) ? subj : `Re: ${subj}`);
    const original = email.html ? sanitize(inlineCid(email.html, email.attachments)) : escapeHtml(email.text || "").replace(/\n/g, "<br>");
    const when = fmtFull(email.date || dateOf(key));
    let quote;
    if (mode === "forward") {
      quote = `<div><br></div><div>---------- Forwarded message ---------<br>From: ${escapeHtml(fmtAddr(fromA))}<br>Date: ${escapeHtml(when)}<br>Subject: ${escapeHtml(subj)}<br>` +
        `To: ${escapeHtml(addrs(email.to).map(fmtAddr).join(", "))}${email.cc ? `<br>Cc: ${escapeHtml(addrs(email.cc).map(fmtAddr).join(", "))}` : ""}</div><div><br></div>${original}`;
    } else {
      quote = `<div><br></div><div>On ${escapeHtml(when)}, ${escapeHtml(fmtAddr(fromA))} wrote:</div><blockquote>${original}</blockquote>`;
    }
    const used = (a) => a.contentId && email.html && email.html.includes(cleanId(a.contentId));
    const attachments = mode === "forward"
      ? (email.attachments || []).filter((a) => !used(a)).map((a) => ({ filename: a.filename || "attachment", contentType: a.mimeType || "application/octet-stream", data: new Uint8Array(a.content) }))
      : [];
    const msgId = m.messageId || cleanId(email.messageId);
    openCompose({
      mode, from, to, cc, subject, attachments,
      html: `<div><br></div>${signatureHtml()}${quote}`,
      inReplyTo: mode === "forward" ? "" : msgId,
      references: mode === "forward" ? [] : [...(m.references || []), msgId].filter(Boolean).slice(-20),
    });
  } catch (e) { handleError(e); }
}

function recipientField(list, onChange, placeholder) {
  const wrap = h("div", { class: "flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1" });
  const input = h("input", { class: "min-w-32 flex-1 bg-transparent py-1 text-sm outline-none", placeholder, autocomplete: "off" });
  const sugg = h("div", { class: "menu hidden", style: "position:fixed" });
  document.body.append(sugg);
  let active = 0, options = [];
  const chips = () => {
    wrap.replaceChildren(...list.map((a, i) => h("span", {
      class: `inline-flex max-w-full items-center gap-1 rounded-full py-0.5 pl-2 pr-1 text-xs ${EMAIL_RE.test(a.address) ? "bg-slate-100 dark:bg-slate-800" : "bg-red-100 text-red-700"}`,
      title: fmtAddr(a),
    }, h("span", { class: "truncate" }, a.name || a.address),
      h("button", { class: "rounded-full px-1 hover:bg-slate-300 dark:hover:bg-slate-600", "aria-label": "Remove", onclick: () => { list.splice(i, 1); chips(); onChange(); } }, "×"))), input);
  };
  const commit = (text = input.value) => {
    const parsed = parseAddresses(text).filter((a) => a.address);
    if (parsed.length) { list.push(...parsed); input.value = ""; chips(); onChange(); input.focus(); }
    hide();
  };
  const hide = () => { sugg.classList.add("hidden"); options = []; };
  const pick = (c) => { list.push({ name: c.name || "", address: c.address }); input.value = ""; chips(); onChange(); hide(); input.focus(); };
  const suggest = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) return hide();
    options = contacts().filter((c) => !list.some((a) => a.address === c.address) && (c.address.includes(q) || c.name.toLowerCase().includes(q))).slice(0, 6);
    if (!options.length) return hide();
    active = Math.min(active, options.length - 1);
    sugg.replaceChildren(...options.map((c, i) => h("button", { class: `menu-item ${i === active ? "bg-slate-100 dark:bg-slate-700" : ""}`, onmousedown: (e) => { e.preventDefault(); pick(c); } },
      avatar(c, "h-6 w-6 text-[10px]"), h("span", { class: "min-w-0" }, h("div", { class: "truncate" }, c.name || c.address), c.name ? h("div", { class: "truncate text-xs text-slate-500" }, c.address) : null))));
    const r = input.getBoundingClientRect();
    sugg.style.left = `${r.left}px`;
    sugg.style.top = `${r.bottom + 4}px`;
    sugg.classList.remove("hidden");
  };
  input.addEventListener("input", () => { active = 0; if (/[,;]$/.test(input.value)) commit(input.value.slice(0, -1)); else suggest(); });
  input.addEventListener("keydown", (e) => {
    if (options.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); active = (active + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length; suggest(); return; }
    if ((e.key === "Enter" || e.key === "Tab") && options.length) { e.preventDefault(); pick(options[active]); return; }
    if ((e.key === "Enter" || e.key === "Tab") && input.value.trim()) { if (e.key === "Enter") e.preventDefault(); commit(); return; }
    if (e.key === "Backspace" && !input.value && list.length) { list.pop(); chips(); onChange(); }
    if (e.key === "Escape") hide();
  });
  input.addEventListener("blur", () => setTimeout(() => { if (input.value.trim()) commit(); hide(); }, 150));
  input.addEventListener("paste", (e) => { const t = e.clipboardData.getData("text"); if (/[,;\n]/.test(t)) { e.preventDefault(); commit(t); } });
  chips();
  return { el: wrap, input, commit: () => commit(), destroy: () => sugg.remove() };
}

function openCompose(opts = {}) {
  if (opts.draft) {
    const existing = composers.find((c) => c.draftKey === opts.draft.key);
    if (existing) { existing.restore(); return; }
  }
  if (composers.length >= 3) { toast("Close a draft window first (max 3 open)."); return; }
  const d = opts.draft || {};
  const s = S();
  const c = {
    id: d.id || crypto.randomUUID(),
    from: d.from || opts.from || s.defaultFrom,
    to: [...(d.to || opts.to || [])],
    cc: [...(d.cc || opts.cc || [])],
    bcc: [...(d.bcc || opts.bcc || [])],
    subject: d.subject ?? opts.subject ?? "",
    inReplyTo: d.inReplyTo ?? opts.inReplyTo ?? "",
    references: d.references || opts.references || [],
    attachments: opts.attachments || [],
    minimized: false,
    maximized: false,
    sending: false,
  };
  c.draftKey = d.key || `drafts/${c.id}.json`;
  let draftSaved = !!d.key;

  const win = h("div", { class: "pointer-events-auto flex w-[34rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-t-xl bg-white shadow-2xl ring-1 ring-slate-300 dark:bg-slate-900 dark:ring-slate-700 max-md:fixed max-md:inset-0 max-md:w-auto max-md:max-w-none max-md:rounded-none" });
  const title = h("span", { class: "min-w-0 flex-1 truncate text-sm font-semibold" }, c.subject || "New message");
  const bar = h("div", { class: "flex cursor-pointer items-center gap-1 bg-slate-800 px-3 py-2 text-white dark:bg-slate-950", onclick: (e) => { if (e.target === bar || e.target === title) toggleMin(); } },
    title,
    h("button", { class: "rounded p-1 hover:bg-white/20", title: "Minimise", onclick: (e) => { e.stopPropagation(); toggleMin(); } }, icon("minus", "h-4 w-4")),
    h("button", { class: "rounded p-1 hover:bg-white/20 max-md:hidden", title: "Full screen", onclick: (e) => { e.stopPropagation(); toggleMax(); } }, icon("expand", "h-4 w-4")),
    h("button", { class: "rounded p-1 hover:bg-white/20", title: "Save & close", onclick: (e) => { e.stopPropagation(); close(true); } }, icon("x", "h-4 w-4")));

  const changed = () => { title.textContent = subjectInput.value || "New message"; scheduleSave(); };
  const fromSel = h("select", { class: "min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none dark:bg-slate-900", onchange: () => { if (fromSel.value === "__other") { const local = prompt(`Send from which address? (…@${DOMAIN})`, ""); if (local && /^[a-z0-9._+-]+$/i.test(local.trim())) { c.from = `${local.trim().toLowerCase()}@${DOMAIN}`; fillFrom(); } else fromSel.value = c.from; } else c.from = fromSel.value; scheduleSave(); } });
  const fillFrom = () => {
    const opts2 = fromOptions();
    if (!opts2.some((o) => o.address === c.from)) opts2.unshift({ address: c.from, name: "" });
    fromSel.replaceChildren(...opts2.map((o) => { const sn = senderFor(o.address).name; return h("option", { value: o.address, selected: o.address === c.from }, sn ? `${sn} <${o.address}>` : o.address); }), h("option", { value: "__other" }, `Other @${DOMAIN} address…`));
  };
  fillFrom();
  const toF = recipientField(c.to, changed, "Recipients");
  const ccF = recipientField(c.cc, changed, "");
  const bccF = recipientField(c.bcc, changed, "");
  const rowCls = "flex items-center gap-2 border-b border-slate-200 px-3 dark:border-slate-700";
  const ccRow = h("div", { class: `${rowCls} ${c.cc.length ? "" : "hidden"}` }, h("span", { class: "w-10 text-sm text-slate-500" }, "Cc"), ccF.el);
  const bccRow = h("div", { class: `${rowCls} ${c.bcc.length ? "" : "hidden"}` }, h("span", { class: "w-10 text-sm text-slate-500" }, "Bcc"), bccF.el);
  const subjectInput = h("input", { class: "w-full bg-transparent py-2 text-sm outline-none", placeholder: "Subject", value: c.subject, oninput: changed });
  const editor = h("div", { class: "editor min-h-56 flex-1 overflow-y-auto px-4 py-3 text-sm leading-relaxed outline-none", contenteditable: "true", "data-placeholder": "Write your message…", spellcheck: "true" });
  editor.innerHTML = sanitize(d.html || opts.html || (signatureHtml() ? `<div><br></div>${signatureHtml()}` : ""));
  editor.addEventListener("input", scheduleSaveProxy);
  editor.addEventListener("paste", (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertHTML", false, html ? sanitize(html) : escapeHtml(text).replace(/\n/g, "<br>"));
  });
  function scheduleSaveProxy() { scheduleSave(); }
  editor.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    if (!dt || dt.files.length) return; // files are handled by the window drop handler
    e.preventDefault();
    const html = dt.getData("text/html");
    const text = dt.getData("text/plain");
    if (html || text) document.execCommand("insertHTML", false, html ? sanitize(html) : escapeHtml(text).replace(/\n/g, "<br>"));
  });

  const attList = h("div", { class: "flex flex-wrap gap-2 px-4 empty:hidden" });
  const renderAtts = () => {
    attList.replaceChildren(...c.attachments.map((a, i) => h("span", { class: "inline-flex max-w-60 items-center gap-1.5 rounded-lg bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800" },
      icon("clip", "h-3.5 w-3.5"), h("span", { class: "truncate" }, a.filename), h("span", { class: "text-slate-500" }, fmtSize(a.data.length)),
      h("button", { class: "rounded px-1 hover:bg-slate-300 dark:hover:bg-slate-600", "aria-label": "Remove attachment", onclick: () => { c.attachments.splice(i, 1); renderAtts(); } }, "×"))));
  };
  const addFiles = async (files) => {
    for (const f of files) {
      const total = c.attachments.reduce((n, a) => n + a.data.length, 0) + f.size;
      if (total > MAX_ATTACH_BYTES) { toast(`Attachments are limited to ${fmtSize(MAX_ATTACH_BYTES)} per email.`); break; }
      c.attachments.push({ filename: f.name, contentType: f.type || "application/octet-stream", data: new Uint8Array(await f.arrayBuffer()) });
    }
    renderAtts();
  };
  const fileInput = h("input", { type: "file", multiple: true, class: "hidden", onchange: (e) => { addFiles([...e.target.files]); e.target.value = ""; } });
  win.addEventListener("dragover", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); win.classList.add("ring-2", "ring-blue-400"); } });
  win.addEventListener("dragleave", () => win.classList.remove("ring-2", "ring-blue-400"));
  win.addEventListener("drop", (e) => { if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); win.classList.remove("ring-2", "ring-blue-400"); addFiles([...e.dataTransfer.files]); } });
  renderAtts();

  const fmt = (cmd, val) => () => { editor.focus(); document.execCommand(cmd, false, val); scheduleSave(); };
  const tb = (label, ttl, fn, cls = "") => h("button", { class: `inline-flex h-8 min-w-8 items-center justify-center rounded px-1.5 text-sm hover:bg-slate-200 dark:hover:bg-slate-700 ${cls}`, title: ttl, onmousedown: (e) => e.preventDefault(), onclick: fn }, label);
  const toolbar = h("div", { class: "flex flex-wrap items-center gap-0.5 border-t border-slate-200 px-2 py-1 dark:border-slate-700" },
    tb(h("b", {}, "B"), "Bold (Ctrl+B)", fmt("bold")), tb(h("i", { class: "font-serif" }, "I"), "Italic (Ctrl+I)", fmt("italic")), tb(h("u", {}, "U"), "Underline (Ctrl+U)", fmt("underline")),
    tb(h("s", {}, "S"), "Strikethrough", fmt("strikeThrough")),
    h("span", { class: "mx-1 h-5 border-l border-slate-300 dark:border-slate-600" }),
    tb(icon("bullets", "h-4 w-4"), "Bulleted list", fmt("insertUnorderedList")), tb(icon("numbers", "h-4 w-4"), "Numbered list", fmt("insertOrderedList")),
    tb(icon("quote", "h-4 w-4"), "Quote", fmt("formatBlock", "blockquote")),
    tb(icon("link", "h-4 w-4"), "Insert link", () => { const url = prompt("Link address (https://…)", "https://"); if (url && /^(https?:|mailto:)/i.test(url.trim())) fmt("createLink", url.trim())(); }),
    tb("T̸", "Remove formatting", fmt("removeFormat")));
  const sendBtn = h("button", { class: "btn-primary rounded-full px-6", title: "Send (Ctrl+Enter)", onclick: () => send() }, "Send");
  const footer = h("div", { class: "flex items-center gap-1 px-3 py-2" },
    sendBtn,
    h("button", { class: "icon-btn ml-1", title: "Attach files", onclick: () => fileInput.click() }, icon("clip")),
    fileInput,
    h("span", { class: "ml-auto text-xs text-slate-400", "data-role": "saved" }),
    iconBtn("trash", "Discard draft", () => discard()));
  const savedLabel = footer.querySelector("[data-role=saved]");

  const bodyEl = h("div", { class: "flex min-h-0 flex-1 flex-col" },
    h("div", { class: rowCls }, h("span", { class: "w-10 text-sm text-slate-500" }, "From"), fromSel),
    h("div", { class: rowCls }, h("span", { class: "w-10 text-sm text-slate-500" }, "To"), toF.el,
      h("button", { class: "text-xs text-slate-500 hover:underline", onclick: () => { ccRow.classList.remove("hidden"); ccF.input.focus(); } }, "Cc"),
      h("button", { class: "text-xs text-slate-500 hover:underline", onclick: () => { bccRow.classList.remove("hidden"); bccF.input.focus(); } }, "Bcc")),
    ccRow, bccRow,
    h("div", { class: "border-b border-slate-200 px-3 dark:border-slate-700" }, subjectInput),
    editor, attList, toolbar, footer);
  win.append(bar, bodyEl);
  win.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send(); }
    if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); toggleMin(true); }
  });
  $("compose-root").append(win);

  function toggleMin(force) {
    c.minimized = force ?? !c.minimized;
    bodyEl.classList.toggle("hidden", c.minimized);
    win.classList.toggle("w-72", c.minimized);
    win.classList.toggle("w-[34rem]", !c.minimized && !c.maximized);
    win.classList.toggle("max-md:inset-0", !c.minimized);
    win.classList.toggle("max-md:fixed", !c.minimized);
  }
  function toggleMax() {
    c.maximized = !c.maximized;
    c.minimized = false;
    bodyEl.classList.remove("hidden");
    win.classList.toggle("fixed", c.maximized);
    win.classList.toggle("inset-x-[8%]", c.maximized);
    win.classList.toggle("inset-y-[6%]", c.maximized);
    win.classList.toggle("rounded-xl", c.maximized);
    win.classList.toggle("w-[34rem]", !c.maximized);
    win.classList.toggle("w-72", false);
  }
  const snapshot = () => ({
    id: c.id, from: c.from, to: c.to, cc: c.cc, bcc: c.bcc, subject: subjectInput.value, html: editor.innerHTML,
    inReplyTo: c.inReplyTo, references: c.references, updated: Date.now(),
  });
  const isEmpty = () => !c.to.length && !c.cc.length && !c.bcc.length && !subjectInput.value.trim() && !htmlToText(editor.innerHTML).replace(/^--\s*$/m, "").trim();
  let saving = null;
  let dirty = false;
  async function saveDraft() {
    if (c.sending || isEmpty()) return;
    saving = doSave();
    return saving;
  }
  async function doSave() {
    try {
      const snap = snapshot();
      await putObject(c.draftKey, JSON.stringify(snap), "application/json");
      draftSaved = true;
      mail.drafts.set(c.draftKey, { ...snap, key: c.draftKey, modified: Date.now() });
      dirty = false;
      savedLabel.textContent = c.attachments.length ? "Draft saved (without attachments)" : "Draft saved";
      if (ui.folder === "drafts") render(); else renderBoxes();
    } catch (e) { if (isAuthError(e)) return handleError(e); savedLabel.textContent = "Couldn't save draft"; }
  }
  const scheduleSaveInner = debounce(saveDraft, 2500);
  const scheduleSave = Object.assign((...a) => { dirty = true; scheduleSaveInner(...a); }, { cancel: () => scheduleSaveInner.cancel() });
  async function removeDraft() {
    scheduleSave.cancel();
    if (saving) await saving.catch(() => {});
    if (draftSaved) { await deleteObject(c.draftKey).catch(() => {}); draftSaved = false; }
    mail.drafts.delete(c.draftKey);
    render();
  }
  function detach() {
    scheduleSave.cancel();
    win.remove();
    [toF, ccF, bccF].forEach((f) => f.destroy());
    const i = composers.indexOf(api);
    if (i >= 0) composers.splice(i, 1);
  }
  async function close(save) {
    if (save && !isEmpty()) { await saveDraft(); toast("Draft saved"); }
    detach();
  }
  async function discard() {
    if (!isEmpty() && !confirm("Discard this draft?")) return;
    detach();
    await removeDraft();
    toast("Draft discarded");
  }
  async function send() {
    if (c.sending) return;
    [toF, ccF, bccF].forEach((f) => f.commit());
    const all = [...c.to, ...c.cc, ...c.bcc];
    if (!all.length) { toast("Add at least one recipient."); toF.input.focus(); return; }
    const bad = all.find((a) => !EMAIL_RE.test(a.address));
    if (bad) { toast(`“${bad.address}” isn't a valid email address.`); return; }
    if (!subjectInput.value.trim() && !confirm("Send this message without a subject?")) return;
    c.sending = true;
    scheduleSave.cancel();
    const message = {
      from: senderFor(c.from), to: c.to, cc: c.cc, bcc: c.bcc, subject: subjectInput.value.trim(),
      html: `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.5">${editor.innerHTML}</body></html>`,
      text: htmlToText(editor.innerHTML),
      attachments: c.attachments, inReplyTo: c.inReplyTo, references: c.references, date: new Date(),
    };
    c.sending = false;
    await saveDraft();          // safety net: if the tab closes during the countdown, the message is still in Drafts
    c.sending = true;
    win.classList.add("hidden");
    const ok = await undoWindow(S().undoSeconds);
    if (!ok) { c.sending = false; win.classList.remove("hidden"); toggleMin(false); return; }
    const t = toast("Sending…", { timeout: 0 });
    try {
      const r = await ses.send(new SendEmailCommand({
        FromEmailAddress: c.from,
        Destination: { ToAddresses: c.to.map((a) => a.address), CcAddresses: c.cc.map((a) => a.address), BccAddresses: c.bcc.map((a) => a.address) },
        Content: { Raw: { Data: buildMime(message) } },
        ConfigurationSetName: C.configurationSet || undefined,
      }));
      t.close();
      detach();
      removeDraft();
      // keep a copy in Sent, with SES's real Message-ID so replies thread correctly
      const messageId = `${r.MessageId}@email.amazonses.com`;
      const copy = buildMime({ ...message, messageId, includeBcc: true });
      const key = `sent/${new Date().toISOString().replace(/[:.]/g, "-")}-${r.MessageId}.eml`;
      try {
        await putObject(key, copy, "message/rfc822");
        const o = { key, box: "sent", modified: new Date(), size: copy.length };
        mail.objects.set(key, o);
        const parsed = await PostalMime.parse(copy);
        mail.meta.set(key, summarize(parsed, o));
        cacheMeta(key, mail.meta.get(key));
        rawCache.set(key, { raw: copy, email: parsed });
        render();
      } catch (e) { console.error(e); toast("Sent, but couldn't save a copy in Sent."); }
      toast("Message sent", { action: { label: "View message", fn: () => { setFolder("sent"); openThread(mail.threadOf.get(key)); } } });
    } catch (e) {
      t.close();
      c.sending = false;
      if (isAuthError(e)) { win.classList.remove("hidden"); return handleError(e); }
      win.classList.remove("hidden");
      toggleMin(false);
      const msg = String(e.message || e);
      const sandbox = /Email address is not verified|not authorized to perform:? '?ses:Send\w*Email'? on resource:? '?arn:aws:ses:[^ ']*:identity\/[^ ']*@/i.test(msg);
      toast(sandbox ? "Not sent: your AWS account is still in the SES sandbox, so it can only send to addresses at your own domain. Request SES production access (free) to send to anyone." : `Not sent: ${msg}`, { timeout: 12000 });
    }
  }
  const api = { draftKey: c.draftKey, restore: () => { toggleMin(false); editor.focus(); }, busy: () => c.sending || dirty };
  composers.push(api);
  if (opts.mode === "reply" || opts.mode === "replyAll") { editor.focus(); placeCaretAtStart(editor); }
  else if (!c.to.length) toF.input.focus();
  else editor.focus();
  return api;
}
function placeCaretAtStart(el) {
  const r = document.createRange();
  r.setStart(el, 0);
  r.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}
function undoWindow(seconds) {
  if (!seconds) return Promise.resolve(true);
  return new Promise((resolve) => {
    let left = seconds;
    let settled = false;
    const t = toast(`Sending in ${left}s…`, { timeout: 0, dismissible: false, action: { label: "Undo", fn: () => { settled = true; clearInterval(iv); resolve(false); toast("Sending undone."); } } });
    const iv = setInterval(() => {
      left--;
      if (settled) return;
      if (left <= 0) { clearInterval(iv); settled = true; t.close(); resolve(true); } else t.set(`Sending in ${left}s…`);
    }, 1000);
  });
}
async function discardDraftKey(key) {
  await deleteObject(key).catch(handleError);
  mail.drafts.delete(key);
  render();
  toast("Draft discarded");
}

// =============================================================== settings
async function openSettings(tab = "general") {
  const dlg = $("settings-dialog");
  const tabs = [["general", "General", "cog"], ["addresses", "Addresses", "at"], ["signature", "Signature", "pencil"], ["security", "Security", "shield"]];
  const content = h("div", { class: "min-h-[24rem] flex-1 overflow-y-auto p-6" });
  const nav = h("nav", { class: "flex shrink-0 gap-1 border-b border-slate-200 p-2 dark:border-slate-800 sm:w-44 sm:flex-col sm:border-b-0 sm:border-r" });
  const show = (id) => {
    nav.querySelectorAll("button").forEach((b) => b.classList.toggle("bg-slate-100", b.dataset.tab === id));
    nav.querySelectorAll("button").forEach((b) => b.classList.toggle("dark:bg-slate-800", b.dataset.tab === id));
    content.replaceChildren(...({ general: settingsGeneral, addresses: settingsAddresses, signature: settingsSignature, security: settingsSecurity }[id])());
  };
  nav.replaceChildren(...tabs.map(([id, label, ic]) => h("button", { class: "flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800", dataset: { tab: id }, onclick: () => show(id) }, icon(ic, "h-4 w-4"), label)));
  dlg.replaceChildren(h("div", { class: "flex max-h-[85vh] flex-col" },
    h("div", { class: "flex items-center border-b border-slate-200 px-6 py-4 dark:border-slate-800" }, h("h2", { class: "text-lg font-semibold" }, "Settings"), h("span", { class: "ml-auto" }), iconBtn("x", "Close", () => dlg.close())),
    h("div", { class: "flex min-h-0 flex-1 flex-col sm:flex-row" }, nav, content)));
  show(tab);
  dlg.showModal();
}
const fieldRow = (label, control, help) => h("div", { class: "mb-5" }, h("label", { class: "mb-1 block text-sm font-medium" }, label), control, help ? h("p", { class: "mt-1 text-xs text-slate-500" }, help) : null);
const toggleRow = (label, checked, onchange, help) => h("label", { class: "mb-4 flex items-start gap-3" },
  h("input", { type: "checkbox", class: "mt-0.5 h-4 w-4 rounded", checked, onchange: (e) => onchange(e.target.checked) }),
  h("span", {}, h("span", { class: "block text-sm font-medium" }, label), help ? h("span", { class: "block text-xs text-slate-500" }, help) : null));
function settingsGeneral() {
  const s = S();
  const theme = localStorage.getItem("mm2:theme") || "system";
  return [
    fieldRow("Your name", h("input", { class: "field", value: s.displayName, placeholder: "e.g. Jane Doe", onchange: (e) => setSettings({ displayName: e.target.value.trim() }) }), "Shown to recipients next to your address."),
    fieldRow("Default “From” address", h("select", { class: "field", onchange: (e) => setSettings({ defaultFrom: e.target.value }) }, fromOptions().map((o) => h("option", { value: o.address, selected: o.address === s.defaultFrom }, o.address)))),
    fieldRow("Undo send", h("select", { class: "field", onchange: (e) => setSettings({ undoSeconds: Number(e.target.value) }) }, [0, 5, 10, 20, 30].map((n) => h("option", { value: n, selected: n === s.undoSeconds }, n ? `${n} seconds` : "Off"))), "How long you can cancel a message after pressing Send."),
    fieldRow("Remote images", h("select", { class: "field", onchange: (e) => setSettings({ remoteImages: e.target.value }) },
      h("option", { value: "ask", selected: s.remoteImages === "ask" }, "Ask before showing (blocks tracking pixels)"),
      h("option", { value: "always", selected: s.remoteImages === "always" }, "Always show")),
      s.trustedSenders.length ? `${plural(s.trustedSenders.length, "trusted sender")}. ` : ""),
    s.trustedSenders.length ? h("button", { class: "btn-ghost -mt-3 mb-4 text-xs", onclick: (e) => { setSettings({ trustedSenders: [] }); e.target.remove(); toast("Trusted senders cleared"); } }, "Clear trusted senders") : null,
    fieldRow("Theme", h("select", { class: "field", onchange: (e) => { localStorage.setItem("mm2:theme", e.target.value); applyTheme(); } },
      [["system", "Match system"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => h("option", { value: v, selected: v === theme }, l)))),
    toggleRow("Conversation view", s.conversationView, (v) => { setSettings({ conversationView: v }); render(); }, "Group replies with the message they belong to."),
    toggleRow("Check for new mail automatically", s.autoRefresh, (v) => setSettings({ autoRefresh: v }), "Every 2 minutes while this tab is visible."),
    toggleRow("Desktop notifications", s.notifications, async (v) => {
      if (v && "Notification" in window && Notification.permission !== "granted") {
        const p = await Notification.requestPermission();
        if (p !== "granted") { toast("Notifications are blocked in your browser settings."); v = false; }
      }
      setSettings({ notifications: v });
    }, "Notify me about new mail while this tab is in the background."),
  ];
}
function settingsAddresses() {
  const s = S();
  const list = h("div", { class: "mb-4 divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700" });
  const draw = () => list.replaceChildren(...S().aliases.map((a, i) => h("div", { class: "flex items-center gap-3 px-3 py-2" },
    icon("at", "h-4 w-4 text-slate-400"),
    h("span", { class: "min-w-0 flex-1 truncate text-sm" }, a.address),
    h("input", { class: "field w-44 py-1", placeholder: "Display name (optional)", value: a.name, onchange: (e) => { const al = [...S().aliases]; al[i] = { ...al[i], name: e.target.value.trim() }; setSettings({ aliases: al }); } }),
    S().aliases.length > 1 ? iconBtn("trash", "Remove", () => { setSettings({ aliases: S().aliases.filter((_, j) => j !== i) }); draw(); }, "h-7 w-7") : null)));
  draw();
  const local = h("input", { class: "field flex-1", placeholder: "e.g. marketing" });
  const add = () => {
    const v = local.value.trim().toLowerCase();
    if (!/^[a-z0-9._+-]+$/.test(v)) { toast("Use letters, numbers, dots, dashes or underscores."); return; }
    const address = `${v}@${DOMAIN}`;
    if (S().aliases.some((a) => a.address === address)) { toast("That address is already in the list."); return; }
    setSettings({ aliases: [...S().aliases, { address, name: "" }] });
    local.value = "";
    draw();
  };
  return [
    h("p", { class: "mb-4 text-sm text-slate-600 dark:text-slate-300" }, `Every address @${DOMAIN} already receives mail automatically. Add the ones you want to send from, so they appear in the “From” menu.`),
    list,
    h("div", { class: "flex items-center gap-2" }, local, h("span", { class: "text-sm text-slate-500" }, `@${DOMAIN}`), h("button", { class: "btn-primary", onclick: add }, "Add")),
    h("p", { class: "mt-6 text-xs text-slate-500" }, `Sender default: ${s.defaultFrom}`),
  ];
}
function settingsSignature() {
  const ed = h("div", { class: "editor min-h-40 rounded-lg border border-slate-300 p-3 text-sm outline-none dark:border-slate-600", contenteditable: "true", "data-placeholder": "e.g. Jane Doe · Software Engineer · example.com" });
  ed.innerHTML = sanitize(S().signature);
  ed.addEventListener("paste", (e) => { e.preventDefault(); const html = e.clipboardData.getData("text/html"); document.execCommand("insertHTML", false, html ? sanitize(html) : escapeHtml(e.clipboardData.getData("text/plain")).replace(/\n/g, "<br>")); });
  return [
    h("p", { class: "mb-3 text-sm text-slate-600 dark:text-slate-300" }, "Added to new messages, replies and forwards."),
    ed,
    h("div", { class: "mt-3 flex gap-2" }, h("button", { class: "btn-primary", onclick: () => { setSettings({ signature: sanitize(ed.innerHTML) }); toast("Signature saved"); } }, "Save signature"),
      h("button", { class: "btn-ghost", onclick: () => { ed.innerHTML = ""; setSettings({ signature: "" }); toast("Signature removed"); } }, "Remove")),
  ];
}
function settingsSecurity() {
  const msg = (el, text, ok) => { el.textContent = text; el.className = `mt-2 text-sm ${ok ? "text-green-700 dark:text-green-400" : "text-red-600"}`; };
  // change password
  const oldP = h("input", { type: "password", class: "field", autocomplete: "current-password", placeholder: "Current password" });
  const newP = h("input", { type: "password", class: "field", autocomplete: "new-password", placeholder: "New password (12+ chars, Aa1)" });
  const newP2 = h("input", { type: "password", class: "field", autocomplete: "new-password", placeholder: "Repeat new password" });
  const pwMsg = h("p", { class: "hidden" });
  const pwBtn = h("button", { class: "btn-primary mt-3", onclick: async () => {
    if (newP.value !== newP2.value) return msg(pwMsg, "The new passwords don't match.");
    pwBtn.disabled = true;
    try {
      await idp.send(new ChangePasswordCommand({ AccessToken: await accessToken(), PreviousPassword: oldP.value, ProposedPassword: newP.value }));
      [oldP, newP, newP2].forEach((i) => { i.value = ""; });
      msg(pwMsg, "Password changed.", true);
    } catch (e) {
      msg(pwMsg, { NotAuthorizedException: "Current password is wrong.", InvalidPasswordException: "Too weak: use 12+ characters with upper and lower case letters and a number.", LimitExceededException: "Too many attempts. Try again later." }[e.name] || e.message);
    } finally { pwBtn.disabled = false; }
  } }, "Change password");

  // 2FA
  const mfaBox = h("div", { class: "text-sm text-slate-500" }, "Checking…");
  const drawMfa = async () => {
    try {
      const u = await idp.send(new GetUserCommand({ AccessToken: await accessToken() }));
      const on = (u.UserMFASettingList || []).includes("SOFTWARE_TOKEN_MFA");
      if (on) {
        mfaBox.replaceChildren(
          h("p", { class: "mb-3 flex items-center gap-2 text-sm text-green-700 dark:text-green-400" }, icon("check", "h-4 w-4"), "Two-step verification is ON. You'll need your authenticator app to sign in."),
          h("button", { class: "btn-ghost text-red-600", onclick: async () => {
            if (!confirm("Turn off two-step verification?")) return;
            await idp.send(new SetUserMFAPreferenceCommand({ AccessToken: await accessToken(), SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false } }));
            toast("Two-step verification turned off");
            drawMfa();
          } }, "Turn off"));
      } else {
        mfaBox.replaceChildren(
          h("p", { class: "mb-3 text-sm text-slate-600 dark:text-slate-300" }, "Protect your account (and your ability to send as your domain) with a 6-digit code from an authenticator app such as Google Authenticator, Microsoft Authenticator, 1Password or Authy."),
          h("button", { class: "btn-primary", onclick: setupMfa }, "Set up two-step verification"));
      }
    } catch (e) { mfaBox.textContent = `Couldn't load 2FA status: ${e.message}`; }
  };
  const setupMfa = async () => {
    try {
      const { SecretCode } = await idp.send(new AssociateSoftwareTokenCommand({ AccessToken: await accessToken() }));
      const label = encodeURIComponent(`${DOMAIN} Mail:${username()}`);
      const uri = `otpauth://totp/${label}?secret=${SecretCode}&issuer=${encodeURIComponent(`${DOMAIN} Mail`)}`;
      const qr = await QRCode.toDataURL(uri, { margin: 1, width: 200 });
      const code = h("input", { class: "field w-40 text-center tracking-[.3em]", inputmode: "numeric", maxlength: "6", placeholder: "123456" });
      const m2 = h("p", { class: "hidden" });
      mfaBox.replaceChildren(
        h("ol", { class: "mb-3 list-decimal space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300" },
          h("li", {}, "Open your authenticator app and scan this QR code."),
          h("li", {}, "Enter the 6-digit code it shows.")),
        h("img", { src: qr, alt: "QR code for your authenticator app", class: "mb-2 h-48 w-48 rounded bg-white p-2" }),
        h("p", { class: "mb-3 break-all font-mono text-xs text-slate-500" }, `Can't scan? Key: ${SecretCode}`),
        h("div", { class: "flex items-center gap-2" }, code, h("button", { class: "btn-primary", onclick: async () => {
          try {
            const r = await idp.send(new VerifySoftwareTokenCommand({ AccessToken: await accessToken(), UserCode: code.value.trim(), FriendlyDeviceName: "Authenticator" }));
            if (r.Status !== "SUCCESS") throw new Error("Code not accepted");
            await idp.send(new SetUserMFAPreferenceCommand({ AccessToken: await accessToken(), SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } }));
            toast("Two-step verification is on");
            drawMfa();
          } catch (e) { msg(m2, e.name === "EnableSoftwareTokenMFAException" || e.name === "CodeMismatchException" ? "That code didn't match. Try the newest code." : e.message); }
        } }, "Verify & turn on")),
        m2);
    } catch (e) { mfaBox.textContent = e.message; }
  };
  drawMfa();
  return [
    h("h3", { class: "mb-2 text-sm font-semibold" }, "Two-step verification"), mfaBox,
    h("hr", { class: "my-6 border-slate-200 dark:border-slate-700" }),
    h("h3", { class: "mb-2 text-sm font-semibold" }, "Change password"),
    h("div", { class: "grid gap-2" }, oldP, newP, newP2), pwMsg, pwBtn,
    h("hr", { class: "my-6 border-slate-200 dark:border-slate-700" }),
    h("h3", { class: "mb-2 text-sm font-semibold" }, "Sessions"),
    h("p", { class: "mb-3 text-sm text-slate-600 dark:text-slate-300" }, "Sign out everywhere, including other browsers and devices."),
    h("button", { class: "btn-ghost text-red-600", onclick: async () => {
      if (!confirm("Sign out on all devices?")) return;
      try { await idp.send(new GlobalSignOutCommand({ AccessToken: await accessToken() })); } catch { /* ignore */ }
      signOut();
    } }, "Sign out of all devices"),
  ];
}
function applyTheme() {
  const t = localStorage.getItem("mm2:theme") || "system";
  const was = isDarkUI();
  document.documentElement.classList.toggle("dark", t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches));
  if (was !== isDarkUI() && ui.open) openThread(ui.open);
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

function showShortcuts() {
  const rows = [["c", "Compose"], ["/", "Search"], ["j / k", "Next / previous conversation"], ["Enter or o", "Open conversation"], ["u or Esc", "Back to list"],
    ["r", "Reply"], ["a", "Reply all"], ["f", "Forward"], ["e", "Archive"], ["#", "Delete"], ["s", "Star / unstar"], ["Shift + i", "Mark as read"], ["Shift + u", "Mark as unread"],
    ["x", "Select conversation"], ["g then i / s / t / d / a", "Go to Inbox / Starred / Sent / Drafts / Archive"], ["Ctrl + Enter", "Send (in compose)"], ["?", "This help"]];
  const dlg = $("shortcuts-dialog");
  dlg.replaceChildren(h("div", { class: "mb-4 flex items-center" }, h("h2", { class: "text-lg font-semibold" }, "Keyboard shortcuts"), h("span", { class: "ml-auto" }), iconBtn("x", "Close", () => dlg.close())),
    h("div", { class: "grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm" }, rows.flatMap(([k, d]) => [h("span", {}, ...k.split(" ").map((p) => (/^(then|or|\/|\+)$/.test(p) && k !== "/" ? ` ${p} ` : h("kbd", { class: "kbd" }, p)))), h("span", { class: "text-slate-600 dark:text-slate-300" }, d)])));
  dlg.showModal();
}

// ================================================================ keyboard
let gPending = false;
document.addEventListener("keydown", (e) => {
  if ($("app").classList.contains("hidden")) return;
  const t = e.target;
  if (t.closest && (t.closest("input,textarea,select,[contenteditable=true]") || t.closest("dialog[open]"))) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if ((e.key === "Enter" || e.key === " ") && t.closest && t.closest("button,a,summary")) return;
  const rows = ui.rows;
  const idx = rows.findIndex((r) => r.tid === ui.open);
  const openKeys = ui.open ? threadForReader(ui.open) : [];
  const last = openKeys[openKeys.length - 1];
  const go = (f) => { gPending = false; setFolder(f); };
  if (gPending) { const map = { i: "inbox", s: "starred", t: "sent", d: "drafts", a: "archive" }; if (map[e.key]) { e.preventDefault(); go(map[e.key]); } gPending = false; return; }
  const act = {
    c: () => openCompose(),
    "/": () => $("search").focus(),
    "?": () => showShortcuts(),
    g: () => { gPending = true; setTimeout(() => { gPending = false; }, 1200); },
    j: () => { const r = rows[idx + 1] || rows[0]; if (r) openThread(r.tid); },
    k: () => { const r = rows[idx - 1] || rows[0]; if (r) openThread(r.tid); },
    o: () => { if (!ui.open && rows[0]) openThread(rows[0].tid); },
    Enter: () => { if (!ui.open && rows[0]) openThread(rows[0].tid); },
    u: () => { ui.open = null; render(); emptyReader(); setView("list"); },
    Escape: () => { ui.open = null; render(); emptyReader(); setView("list"); },
    r: () => last && startReply(last, "reply"),
    a: () => last && startReply(last, "replyAll"),
    f: () => last && startReply(last, "forward"),
    e: () => { const keys = ui.open ? openKeys : selectedKeys(); if (keys.length) { setFlags(keys, { arch: true }, "Archived"); ui.selected.clear(); if (ui.open) { const n = rows[idx + 1]; ui.open = null; n ? openThread(n.tid) : emptyReader(); } } },
    "#": () => { const keys = ui.open ? openKeys : selectedKeys(); if (keys.length) { setFlags(keys, { trash: Date.now() }, "Moved to Trash"); ui.selected.clear(); if (ui.open) { const n = rows[idx + 1]; ui.open = null; n ? openThread(n.tid) : emptyReader(); } } },
    s: () => { const r = rows[idx]; if (r) toggleStar(r); },
    I: () => { const keys = ui.open ? openKeys : selectedKeys(); if (keys.length) setFlags(keys, { read: true }); },
    U: () => { const keys = ui.open ? openKeys.slice(-1) : selectedKeys(); if (keys.length) setFlags(keys, { read: false }); },
    x: () => { const r = rows[idx]; if (r) { if (ui.selected.has(r.tid)) ui.selected.delete(r.tid); else ui.selected.add(r.tid); render(); } },
  }[e.key];
  if (act) { e.preventDefault(); act(); }
});

// ============================================================== boot/login
function showLogin(message) {
  $("app").classList.replace("flex", "hidden");
  $("login").classList.replace("hidden", "flex");
  $("login-step-password").classList.remove("hidden");
  $("login-step-mfa").classList.add("hidden");
  $("login-btn").textContent = "Sign in";
  $("login-error").textContent = message || "";
  $("login-error").classList.toggle("hidden", !message);
  $("keep-signed-in").checked = localStorage.getItem("mm2:keep") === "1";
  setTimeout(() => $("username").focus(), 0);
}
function showApp() {
  $("login").classList.replace("flex", "hidden");
  $("app").classList.replace("hidden", "flex");
  setAccount();
  setView("list");
  emptyReader();
  render();
}
function setAccount() {
  const name = S().displayName || username();
  $("account-btn").textContent = (name || "?").slice(0, 1).toUpperCase();
  $("account-btn").title = `${name} · ${DOMAIN}`;
}
function signOut() {
  const rt = tok("refreshToken");
  if (rt) idp.send(new RevokeTokenCommand({ Token: rt, ClientId: C.clientId })).catch(() => {});
  clearTokens();
  awsCreds = null;
  for (const k of Object.keys(localStorage)) if (k.startsWith(LS)) localStorage.removeItem(k);
  mail.meta = new Map();
  rawCache.clear();
  store.data = { v: 2, msgs: {}, settings: {}, settingsT: 0 };
  store.remoteExists = false;
  mail.objects = new Map();
  mail.drafts = new Map();
  mail.loaded = false;
  ui.open = null;
  $("compose-root").replaceChildren();
  composers.length = 0;
  showLogin();
}
function handleError(e) {
  console.error(e);
  if (isAuthError(e)) { signOut(); showLogin("Your session ended. Please sign in again."); }
  else if (e) toast(`Error: ${e.message || e}`, { timeout: 8000 });
}
async function start() {
  showApp();
  try {
    await loadState();
    setAccount();
    render();
    await refresh();
    const n = unreadCount(PRED.inbox);
    setStatus(n ? `${plural(n, "unread conversation")}` : "");
  } catch (e) { handleError(e); }
}

let mfaSession = null;
$("login-domain").textContent = DOMAIN;
$("hdr-domain").textContent = DOMAIN;
$("login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = $("login-btn");
  btn.disabled = true;
  $("login-error").classList.add("hidden");
  try {
    const user = $("username").value.trim();
    if (mfaSession) {
      await answerMfa(user, $("mfa-code").value.trim(), mfaSession);
      mfaSession = null;
    } else {
      localStorage.setItem("mm2:keep", $("keep-signed-in").checked ? "1" : "0");
      const r = await signIn(user, $("password").value);
      if (r.mfa) {
        mfaSession = r.session;
        $("login-step-password").classList.add("hidden");
        $("login-step-mfa").classList.remove("hidden");
        btn.textContent = "Verify";
        $("mfa-code").value = "";
        $("mfa-code").focus();
        return;
      }
    }
    $("password").value = "";
    start();
  } catch (e) {
    const wasMfa = !!mfaSession;
    if (e.name === "CodeMismatchException") { $("login-error").textContent = "That code didn't match. Try the newest one."; $("login-error").classList.remove("hidden"); return; }
    mfaSession = null;
    showLogin(e.name === "NotAuthorizedException" ? (wasMfa ? "Sign-in expired. Please start again." : "Incorrect username or password.") : e.message || String(e));
  } finally {
    btn.disabled = false;
  }
});

// header icons and actions
$("menu-btn").replaceChildren(icon("menu"));
$("refresh-btn").replaceChildren(icon("refresh"));
$("settings-btn").replaceChildren(icon("cog"));
$("compose-btn").replaceChildren(icon("pencil", "h-5 w-5"), "Compose");
$("search").previousElementSibling.replaceChildren(icon("search", "h-4 w-4"));
$("menu-btn").addEventListener("click", () => setView("boxes"));
$("refresh-btn").addEventListener("click", () => refresh().catch(handleError));
$("settings-btn").addEventListener("click", () => openSettings());
$("compose-btn").addEventListener("click", () => { openCompose(); if (ui.view === "boxes") setView("list"); });
$("account-btn").addEventListener("click", (e) => showMenu(e.currentTarget, [
  { label: `${S().displayName || username()} · ${DOMAIN}`, onClick: () => openSettings("general") },
  "-",
  { label: "Settings", icon: "cog", onClick: () => openSettings() },
  { label: "Security & 2FA", icon: "shield", onClick: () => openSettings("security") },
  { label: "Keyboard shortcuts", icon: "keyboard", onClick: showShortcuts },
  "-",
  { label: "Sign out", icon: "signout", onClick: signOut },
]));
$("search").addEventListener("input", debounce((e) => { ui.query = e.target.value.trim(); ui.page = 1; ui.selected.clear(); render(); }, 200));
$("search").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.target.value = ""; ui.query = ""; render(); e.target.blur(); } });

// warn before leaving while a message is mid-send or has unsaved edits
window.addEventListener("beforeunload", (e) => { if (composers.some((c) => c.busy())) { e.preventDefault(); e.returnValue = ""; } });

// gentle auto-refresh: only while the tab is visible
setInterval(() => {
  if (!document.hidden && S().autoRefresh && tok("refreshToken") && !mail.loading && Date.now() - mail.lastRefresh > 110000) refresh({ silent: true }).catch(handleError);
}, 30000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && S().autoRefresh && tok("refreshToken") && mail.loaded && Date.now() - mail.lastRefresh > 120000) refresh({ silent: true }).catch(handleError);
});

if (tok("refreshToken")) start(); else showLogin();
