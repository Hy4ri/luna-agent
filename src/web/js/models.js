// Moved verbatim from the original inline app script; see CONTRACT.md module map.
import { json, post } from "./api.js";
import { $, h } from "./dom.js";
import { newSession, session, viewEpoch } from "./session.js";
import { addErr } from "./transcript.js";

export let modelList = [];
export let defaultModel = null;
// ---- models / thinking ----
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
let selectedModel = null;
const PIN_KEY = "luna.pinnedModels";
function readModelPins() {
  try {
    const pins = JSON.parse(localStorage.getItem(PIN_KEY) || "[]");
    return new Set(Array.isArray(pins) ? pins.filter(p => typeof p === "string") : []);
  } catch { return new Set(); }
}
const modelKey = m => m.provider + "/" + m.id;
export function setSelectedModel(m) { selectedModel = m; updateModelLabel(); }
function updateModelLabel() {
  const key = selectedModel && selectedModel.provider + "/" + selectedModel.modelId;
  const m = modelList.find(m => modelKey(m) === key);
  $("model").textContent = m ? m.provider + " · " + (m.name || m.id) : key || "Choose model";
  $("model").title = $("model").textContent;
}
function renderModelPicker(openProviders = new Set()) {
  const box = $("model-picker"), pins = readModelPins();
  box.replaceChildren();
  function row(m, available = true) {
    const key = modelKey(m), pinned = pins.has(key);
    const choice = h("button", { type: "button", class: "model-choice", "data-model": key,
      "aria-current": String(selectedModel?.provider === m.provider && selectedModel?.modelId === m.id),
      onclick: async () => {
        choice.disabled = true;
        try {
          const target = session || String(await newSession() || "");
          if (!target) return;
          await post(`/v1/sessions/${target}`, { model: { provider: m.provider, modelId: m.id } }, "PATCH");
          if (session === target) { selectedModel = { provider: m.provider, modelId: m.id }; updateModelLabel(); box.hidePopover(); $("model").focus(); }
        } catch (e) { addErr(e.message); }
        finally { choice.disabled = !available; }
      } }, m.name || m.id, h("small", {}, m.provider + (available ? "" : " · Unavailable")));
    choice.disabled = !available;
    return h("div", { class: "model-row" }, choice, h("button", { type: "button", class: "model-pin",
      "aria-label": (pinned ? "Unpin " : "Pin ") + key, "aria-pressed": String(pinned), onclick: () => {
        const next = readModelPins(); if (next.has(key)) next.delete(key); else next.add(key);
        try { localStorage.setItem(PIN_KEY, JSON.stringify([...next])); }
        catch { addErr("Could not save pinned models in this browser."); return; }
        const open = new Set([...box.querySelectorAll("details[open]")].map(d => d.dataset.provider));
        renderModelPicker(open);
        [...box.querySelectorAll(".model-pin")].find(b => b.getAttribute("aria-label") === (next.has(key) ? "Unpin " : "Pin ") + key)?.focus();
      } }, pinned ? "Unpin" : "Pin"));
  }
  if (pins.size) {
    const section = h("section", { "aria-label": "Pinned models", "data-pinned-models": "" }, h("b", {}, "Pinned"));
    for (const key of pins) {
      const m = modelList.find(m => modelKey(m) === key);
      const [provider, ...id] = key.split("/");
      section.append(row(m || { provider, id: id.join("/") }, !!m));
    }
    box.append(section);
  }
  const providers = new Map();
  for (const m of modelList) {
    if (!providers.has(m.provider)) providers.set(m.provider, []);
    providers.get(m.provider).push(m);
  }
  for (const [provider, models] of providers) {
    const group = h("details", { "data-provider": provider }, h("summary", {}, provider + " (" + models.length + ")"), ...models.map(m => row(m)));
    group.open = openProviders.has(provider); box.append(group);
  }
  if (!modelList.length) box.append(h("p", { class: "muted" }, "No connected models. Connect a provider to choose a model."));
}
$("model-picker").addEventListener("beforetoggle", e => {
  $("model").setAttribute("aria-expanded", String(e.newState === "open"));
  if (e.newState === "open") {
    // The model chip sits in the composer toolbar, so the picker opens above it.
    const r = $("model").getBoundingClientRect(), w = Math.min(380, innerWidth - 16), box = $("model-picker");
    box.style.width = w + "px"; box.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
    box.style.bottom = (innerHeight - r.top + 8) + "px"; box.style.top = "auto"; box.style.right = "auto";
    box.style.maxHeight = Math.max(160, r.top - 16) + "px";
    renderModelPicker();
  }
});
export async function loadModels() {
  try { const r = await json("/v1/models"); modelList = r.models; defaultModel = r.default; } catch { modelList = []; }
  if (!session) selectedModel = defaultModel;
  updateModelLabel();
  if ($("model-picker").matches(":popover-open")) renderModelPicker();
  const t = $("think"); t.replaceChildren(...LEVELS.map((l) => h("option", { value: l }, l === "off" ? "Off" : l.charAt(0).toUpperCase() + l.slice(1))));
}
$("think").onchange = async () => { const sid = session, epoch = viewEpoch; if (!sid) return; await post(`/v1/sessions/${sid}`, { thinkingLevel: $("think").value }, "PATCH").catch(e => { if (epoch === viewEpoch) addErr(e.message); }); };
