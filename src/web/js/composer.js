// Moved verbatim from the original inline app script; see CONTRACT.md module map.
import { post } from "./api.js";
import { $, MOBILE, h } from "./dom.js";
import { newSession, session, updateRunControls, viewEpoch } from "./session.js";
import { loadSessions } from "./sidebar.js";
import { addErr, renderSideJobs, sideJobs } from "./transcript.js";

let attachments = []; // { mimeType, data, url }
let composerSession;
export const drafts = new Map(), submissions = new Map(), sendErrors = new Map();
try {
  for (const [id, text] of JSON.parse(sessionStorage.getItem("luna.drafts") || "[]")) {
    if ((id === null || typeof id === "string") && typeof text === "string") drafts.set(id, { text, attachments: [] });
  }
} catch {}
export function saveDraft() {
  if (composerSession === undefined) return;
  drafts.set(composerSession, { text: $("input").value, attachments });
  try { sessionStorage.setItem("luna.drafts", JSON.stringify([...drafts].map(([id, draft]) => [id, draft.text]))); } catch {}
}
export function restoreDraft() {
  composerSession = session;
  const draft = drafts.get(session);
  $("input").value = draft?.text || ""; attachments = draft?.attachments || [];
  renderAtts(); grow();
}
// ---- attachments ----
$("attach").onclick = () => $("file").click();
$("file").onchange = async () => {
  for (const f of $("file").files) await addAttachment(f);
  $("file").value = "";
};
document.addEventListener("paste", async (e) => { for (const it of e.clipboardData?.items || []) if (it.type.startsWith("image/")) { e.preventDefault(); await addAttachment(it.getAsFile()); } });
async function addAttachment(file) {
  const target = attachments, owner = session;
  if (!/^(image\/(png|jpeg|gif|webp)|audio\/(mpeg|mp3|wav|x-wav|ogg|webm|mp4|flac))$/.test(file.type)) return addErr("Unsupported image or audio type.");
  if (attachments.length >= 8) return addErr("At most 8 attachments per message.");
  const blob = file.type.startsWith("audio/") ? file : await shrink(file);
  const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(",")[1]); fr.readAsDataURL(blob); });
  if (target.length >= 8) return;
  target.push({ mimeType: blob.type, data, url: URL.createObjectURL(blob) });
  if (owner === session && target === attachments) renderAtts();
}
// Downscale big photos to 2000px max so uploads stay small; GIFs pass through.
async function shrink(file) {
  if (file.type === "image/gif") return file;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp || Math.max(bmp.width, bmp.height) <= 2000) return file;
  const k = 2000 / Math.max(bmp.width, bmp.height);
  const c = h("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob((b) => r(b || file), "image/jpeg", 0.88));
}
function renderAtts() {
  $("atts").replaceChildren(...attachments.map((a, i) => h("div", {}, a.mimeType.startsWith("audio/") ? h("span", {}, "Audio attachment") : h("img", { src: a.url, alt: "attachment" }), h("button", { type: "button", "aria-label": "Remove attached image " + (i + 1), onclick: () => { URL.revokeObjectURL(a.url); attachments.splice(i, 1); renderAtts(); } }, "×"))));
}

export function renderSendError() {
  $("log").querySelector(".send-error")?.remove();
  const error = sendErrors.get(session); if (!error) return;
  const sid = session;
  $("log").append(h("div", { class: "msg err send-error" }, h("p", {}, "Send not confirmed: " + error.message),
    h("button", { disabled: submissions.has(sid) ? "" : null, onclick: () => submitMessage(sid, error.body) }, "Retry send")));
}
async function submitMessage(sid, body) {
  if (submissions.has(sid)) return;
  submissions.set(sid, body);
  if (session === sid) { updateRunControls(); renderSendError(); }
  try {
    const result = await post(`/v1/sessions/${sid}/messages?async=1`, body);
    if (session === sid && result) {
      if (result.job) {
        const old = sideJobs.get(result.job.id);
        if (!old || old.status === "running") sideJobs.set(result.job.id, result.job);
        renderSideJobs();
      }
      const lines = [result.tip, result.notice, ...(result.queue || []).map(row => `${row.number}. ${typeof row.content === "string" ? row.content : JSON.stringify(row.content)}`)].filter(Boolean);
      if (lines.length) {
        $("busyFeedback").textContent = lines.join("\n");
        $("busyFeedback").hidden = false;
      }
    }
    sendErrors.delete(sid);
  } catch (e) {
    if (e.message !== "unauthorized") sendErrors.set(sid, { body, message: e.message });
  } finally {
    submissions.delete(sid);
    if (session === sid) { updateRunControls(); renderSendError(); }
    loadSessions().catch(() => {});
  }
}
function randomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
      (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16)
    );
  }
  return "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
export async function send(text, atts) {
  let sid = session;
  const content = atts.length ? [...(text ? [{ type: "text", text }] : []), ...atts.map(a => ({ type: a.mimeType.startsWith("audio/") ? "audio" : "image", data: a.data, mimeType: a.mimeType }))] : text;
  for (const a of atts) URL.revokeObjectURL(a.url);
  if (!sid) { const id = await newSession(); if (!id) return; sid = String(id); }
  await submitMessage(sid, { content, requestId: randomId() });
}
const input = $("input");
export const grow = () => { input.style.height = "auto"; input.style.height = Math.max(input.scrollHeight + 2, 38) + "px"; };
input.addEventListener("input", () => { grow(); saveDraft(); });
input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !matchMedia(MOBILE).matches) { e.preventDefault(); $("form").requestSubmit(); } });
$("form").onsubmit = e => {
  e.preventDefault();
  const text = input.value.trim();
  if ((!text && !attachments.length) || $("send").disabled) return;
  const atts = attachments; attachments = []; renderAtts(); input.value = ""; grow(); saveDraft();
  const epoch = viewEpoch;
  send(text, atts).catch(error => { if (epoch === viewEpoch) addErr(error.message); });
};

