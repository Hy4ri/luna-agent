// Moved verbatim from the original inline app script; see CONTRACT.md module map.
import { api } from "./api.js";
import { $, h, icon } from "./dom.js";
import { markdown } from "./markdown.js";
import { openSession } from "./session.js";

export function showWelcome() {
  if ($("log").children.length) return;
  $("log").append(h("section", { id: "welcome" },
    h("div", { class: "welcome-mark", "aria-hidden": "true" }, icon("moon")),
    h("h2", {}, "What are we working on?"),
    h("p", {}, "Start a conversation, or pick up where you left off.", h("br"), "Your tools and settings are in the workspace menu.")));
}
function clearWelcome() { $("welcome")?.remove(); }
$("log").addEventListener("scroll", () => { const l = $("log"); $("jump").hidden = l.scrollHeight - l.scrollTop - l.clientHeight < 200; });
$("jump").onclick = () => scroll(true);
// Side results are transport state, never model-visible transcript entries.
export const sideJobs = new Map();
let sideMediaUrls = new Map();
export function setSideJobs(jobs) { sideJobs.clear(); for (const job of jobs || []) sideJobs.set(job.id, job); renderSideJobs(); }
export function clearSideJobs() {
  sideJobs.clear();
  for (const promise of sideMediaUrls.values()) promise.then(url => URL.revokeObjectURL(url)).catch(() => {});
  sideMediaUrls.clear();
}
export function renderSideJobs() {
  $("log").querySelector(".side-jobs")?.remove();
  if (!sideJobs.size) return;
  clearWelcome();
  const box = h("section", { class: "side-jobs", "aria-label": "Side questions and background tasks" });
  for (const job of [...sideJobs.values()].sort((a, b) => a.createdAt - b.createdAt)) {
    const state = job.status === "running" ? "Started" : job.status === "complete" ? "Complete" : "Failed";
    const card = h("div", { class: "msg assistant side-job", "data-side-job": job.id },
      h("p", { class: "muted" }, `/${job.kind} · ${state} · ${job.id} · Not in main history`), h("p", {}, job.prompt));
    const answer = h("div", { class: "md" });
    let tail = job.text || "";
    for (const media of job.media || []) {
      const at = tail.indexOf(media.directive);
      if (at < 0) continue;
      answer.append(markdown(tail.slice(0, at))); tail = tail.slice(at + media.directive.length);
      const slot = h("div", { class: "side-media" }, h("span", { class: "muted" }, "Loading " + media.name + "…"));
      answer.append(slot);
      if (!sideMediaUrls.has(media.url)) sideMediaUrls.set(media.url, api(media.url).then(async response => {
        if (!response.ok) throw new Error("Media file unavailable: " + media.name);
        return URL.createObjectURL(await response.blob());
      }));
      sideMediaUrls.get(media.url).then(url => {
        slot.replaceChildren();
        if (media.type === "image") slot.append(h("img", { class: "att", src: url, alt: media.name }));
        else if (media.type === "voice") slot.append(h("audio", { src: url, controls: "", preload: "metadata" }));
        else if (media.type === "video") slot.append(h("video", { src: url, controls: "", preload: "metadata", style: "max-width:100%" }));
        slot.append(h("a", { href: url, download: media.name }, media.name));
      }).catch(error => { slot.textContent = error.message; });
    }
    answer.append(markdown(tail)); card.append(answer); box.append(card);
  }
  $("log").append(box); scroll();
}

// ---- transcript rendering ----
export function textBlocks(content) {
  if (typeof content === "string") return content;
  return (content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
}
export function scroll(force) { const l = $("log"); if (force || l.scrollHeight - l.scrollTop - l.clientHeight < 200) l.scrollTop = l.scrollHeight; }
export function addUser(content) {
  clearWelcome();
  const d = h("div", { class: "msg user" });
  if (typeof content === "string") d.append(content);
  else for (const c of content || []) {
    if (c.type === "text") d.append(c.text);
    else if (c.type === "image") d.append(h("img", { class: "att", src: `data:${c.mimeType};base64,${c.data}`, alt: "attachment" }));
  }
  $("log").append(d); scroll(true); return d;
}
export function addAssistant(text) { clearWelcome(); const d = h("div", { class: "msg assistant md" }); d.append(markdown(text)); $("log").append(d); scroll(); return d; }
export function setAssistant(d, text) { d.replaceChildren(markdown(text)); }
export function addErr(text) { clearWelcome(); const d = h("div", { class: "msg err" }, text); $("log").append(d); scroll(); return d; }
export function addTool(name, args, output, isError) {
  clearWelcome();
  const s = h("summary", {}, (isError ? "Failed · " : "Tool · ") + name);
  const pre = h("pre", {}, (args ? "args: " + JSON.stringify(args, null, 1) + "\n" : "") + (output ? "\n" + output : ""));
  const d = h("details", { class: "tool" }, s, pre);
  $("log").append(d); scroll();
  return { el: d, pre, s, name };
}
// Link a delegate_task spawn result to the child session.
function linkChild(view, out) {
  const m = view.name === "delegate_task" && /spawned child (\d+)/.exec(out || "");
  if (m) view.s.append(" ", h("a", { onclick: (e) => { e.preventDefault(); openSession(m[1]); } }, "→ child " + m[1]));
}
export function finishTool(view, m) {
  const out = textBlocks(m.content);
  view.pre.textContent += "\n" + out;
  if (m.isError) view.s.textContent = "Failed · " + view.name;
  linkChild(view, out);
  for (const image of view.el.querySelectorAll(".tool-image")) image.remove();
  for (const block of Array.isArray(m.content) ? m.content : []) {
    if (block.type === "image" && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(block.mimeType) && typeof block.data === "string")
      view.el.append(h("img", { class: "tool-image", src: `data:${block.mimeType};base64,${block.data}`, alt: view.name + " result" }));
  }
}

// ---- usage ----
export function showUsage(u) {
  if (!u?.models) { $("usage").textContent = ""; return; }
  let inT = 0, outT = 0, cost = 0;
  for (const v of Object.values(u.models)) { inT += v.input + (v.cacheRead || 0) + (v.cacheWrite || 0); outT += v.output; cost += v.cost?.total || 0; }
  $("usage").textContent = `${(inT / 1000).toFixed(1)}k in · ${(outT / 1000).toFixed(1)}k out${cost ? " · $" + cost.toFixed(4) : ""}`;
}
