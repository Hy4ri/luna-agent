// Moved verbatim from the original inline app script; see CONTRACT.md module map.
import { api, json, post } from "./api.js";
import { send } from "./composer.js";
import { $, MOBILE, h } from "./dom.js";
import { loadModels, modelList } from "./models.js";
import { clearConversation, openSession, session } from "./session.js";
import { analyticsOpen, closeSettingsScreen, cronOpen, openAnalyticsScreen, openCronScreen, openSettingsScreen, setDrawer, settingsOpen } from "./shell.js";
import { loadProjects, loadSessions, managedSession, projectList, sessionList } from "./sidebar.js";

let returnFocus = null;
export let boardEditing = false, boardArchived = false;
const COLUMNS = [["backlog", "Backlog"], ["todo", "To do"], ["in_progress", "In progress"], ["review", "Review"], ["done", "Done"]];
$("more").onclick = () => openPanel("session");
// ---- panels ----
const panels = {
  async conversation(body) {
    await loadSessions();
    const id = managedSession, s = sessionList.find(s => String(s.id) === String(id));
    if (!s) return body.append(h("p", { role: "status" }, "This conversation no longer exists."));
    const title = h("input", { "aria-label": "Conversation name", maxlength: 200, value: s.title || "Conversation " + id });
    const status = h("p", { class: "muted", role: "status", "aria-live": "polite" });
    const form = h("div", { class: "grid" });
    const mutate = async (changes, remove = false) => {
      form.inert = true;
      try {
        const result = remove ? await json(`/v1/sessions/${id}`, { method: "DELETE" }) : await post(`/v1/sessions/${id}/metadata`, changes, "PATCH");
        if ((remove && result.deleted.some(n => String(n) === String(session))) || (changes.archived && String(session) === String(id))) clearConversation();
        await loadSessions();
        if (remove) closePanel(); else await refresh();
      } catch (e) { status.textContent = e.message; }
      finally { form.inert = false; }
    };
    const save = h("button", { type: "submit" }, "Save name");
    const rename = h("form", { class: "grid", onsubmit: e => {
      e.preventDefault(); if (!title.value.trim()) { status.textContent = "Enter a conversation name."; title.focus(); return; }
      mutate({ title: title.value.trim() });
    } }, h("label", { class: "field-label" }, h("span", {}, "Conversation name"), title), save);
    const archive = h("button", { onclick: () => mutate({ archived: !s.archived }) }, s.archived ? "Restore conversation" : "Archive conversation");
    const remove = h("button", { style: "color:var(--err)", onclick: () => {
      if (confirm('Permanently delete "' + (s.title || "Conversation " + id) + '" and all its child conversations and forks? Stored messages and search entries will be removed. This cannot be undone.')) mutate({}, true);
    } }, "Delete permanently");
    archive.disabled = remove.disabled = !!s.running;
    form.append(rename, h("div", { class: "row" },
      h("button", { "aria-pressed": String(s.pinned), onclick: () => mutate({ pinned: !s.pinned }) }, s.pinned ? "Unpin conversation" : "Pin to top"), archive),
      h("p", { class: "muted" }, "Archive hides this conversation from the active list. You can restore it from the Archived view."), remove,
      h("p", { class: "muted" }, "Delete removes the conversation, its children and forks, and their stored history. Stop any running tasks before deleting."));
    body.append(form, status);
  },
  async projects(body) {
    const r = await json("/v1/projects").catch(e => ({ error: e.message }));
    if (r.error) return body.append(h("p", { class: "muted" }, r.error));
    const act = async fn => { try { await fn(); await loadProjects(); refresh(); } catch (e) { toast(body, e.message); } };
    const name = h("input", { placeholder: "name" }), cwd = h("input", { placeholder: "/absolute/working/directory" });
    body.append(h("p", { class: "muted" }, "New conversations in a project start in its directory. Editing or deleting a project does not change existing conversations."),
      h("div", { class: "card grid" }, h("b", {}, "Add project"), name, cwd,
        h("div", { class: "row" }, h("button", { onclick: () => act(async () => { await post("/v1/projects", { name: name.value, cwd: cwd.value.trim() }); }) }, "Add"))));
    if (!r.projects.length) body.append(h("p", { class: "muted" }, "No projects yet."));
    for (const p of r.projects) {
      const n = h("input", { "aria-label": "Project name", value: p.name }), d = h("input", { "aria-label": "Working directory", value: p.cwd });
      body.append(h("div", { class: "card grid" }, n, d, h("div", { class: "row" },
        h("button", { onclick: () => act(() => post(`/v1/projects/${p.id}`, { name: n.value, cwd: d.value.trim() }, "PATCH")) }, "Save"),
        h("button", { style: "color:var(--err)", onclick: () => { if (confirm(`Delete project "${p.name}"? Its conversations stay.`)) act(() => api(`/v1/projects/${p.id}`, { method: "DELETE" }).then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); })); } }, "Delete"))));
    }
  },
  async board(body) {
    const pid = Number($("project").value);
    const project = projectList.find(p => p.id === pid);
    if (!project) return body.append(h("p", { class: "muted" }, "Choose a project in the sidebar to see its board."));
    const base = `/v1/projects/${pid}`;
    const { cards } = await json(`${base}/board${boardArchived ? "?archived=1" : ""}`);
    const act = async fn => { try { await fn(); boardEditing = false; await refresh(); } catch (e) { toast($("pbody"), e.message); } };
    const sel = (opts, value, label) => { const e = h("select", { "aria-label": label }, ...opts.map(([v, t]) => h("option", { value: v }, t))); e.value = value; return e; };
    const PRI = [["low", "Low"], ["medium", "Medium"], ["high", "High"], ["urgent", "Urgent"]];
    const edit = c => {
      boardEditing = true; const host = $("pbody"); host.replaceChildren();
      const f = { subject: h("input", { "aria-label": "Name", value: c?.subject || "" }), description: h("textarea", { rows: 5, "aria-label": "Description" }),
        priority: sel(PRI, c?.priority || "medium", "Priority"), status: sel(COLUMNS, c?.status || "backlog", "Column"),
        owner: h("input", { "aria-label": "Owner", value: c?.owner || "" }), labels: h("input", { "aria-label": "Labels, comma separated", value: (c?.labels || []).join(", ") }),
        blocked: h("input", { "aria-label": "Waits on card ids, comma separated", value: (c?.blockedBy || []).join(", ") }) };
      f.description.value = c?.description || "";
      const field = (t, el) => h("label", { class: "field-label" }, h("span", {}, t), el);
      const save = () => act(async () => {
        const list = v => v.split(",").map(x => x.trim()).filter(Boolean);
        const data = { subject: f.subject.value, description: f.description.value, priority: f.priority.value, status: f.status.value,
          owner: f.owner.value.trim() || null, labels: list(f.labels.value), blockedBy: list(f.blocked.value).map(x => Number(x.replace("#", ""))) };
        if (c) await post(`${base}/cards/${c.id}`, data, "PATCH"); else await post(`${base}/cards`, data);
      });
      host.append(h("div", { class: "card grid" }, h("b", {}, c ? "Card #" + c.id : "New card"),
        field("Name", f.subject), field("Description", f.description),
        h("div", { class: "row" }, field("Priority", f.priority), field("Column", f.status)),
        field("Owner", f.owner), field("Labels", f.labels), field("Waits on (card ids)", f.blocked),
        h("div", { class: "row" }, h("button", { onclick: save }, "Save"), h("button", { onclick: () => act(async () => {}) }, "Cancel"),
          c ? h("button", { onclick: () => act(() => post(`${base}/cards/${c.id}`, { archived: !c.archived }, "PATCH")) }, c.archived ? "Restore" : "Archive") : null,
          c ? h("button", { style: "color:var(--err)", onclick: () => { if (confirm(`Delete card #${c.id} permanently?`)) act(() => api(`${base}/cards/${c.id}`, { method: "DELETE" }).then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); })); } }, "Delete") : null)));
    };
    const toggle = h("button", { onclick: () => { boardArchived = !boardArchived; refresh(); } }, boardArchived ? "Back to board" : "Archived");
    body.append(h("div", { class: "row" }, h("b", { class: "grow" }, project.name), toggle, boardArchived ? null : h("button", { onclick: () => edit(null) }, "New card")));
    if (boardArchived) {
      if (!cards.length) body.append(h("p", { class: "muted" }, "No archived cards."));
      for (const c of cards) body.append(h("div", { class: "kcard" }, h("button", { class: "subject", onclick: () => edit(c) }, `#${c.id} ${c.subject}`)));
      return;
    }
    const done = new Set(cards.filter(c => c.status === "done").map(c => c.id));
    const cols = COLUMNS.map(([status, title]) => {
      const mine = cards.filter(c => c.status === status);
      return h("div", { class: "col" }, h("div", { class: "eyebrow" }, h("span", {}, title), h("span", {}, String(mine.length))),
        ...mine.map(c => {
          const move = sel(COLUMNS, c.status, "Move card #" + c.id);
          move.onchange = () => act(() => post(`${base}/cards/${c.id}`, { status: move.value }, "PATCH"));
          const waits = c.blockedBy.filter(d => !done.has(d));
          return h("div", { class: "kcard " + c.priority },
            h("button", { class: "subject", onclick: () => edit(c) }, `#${c.id} ${c.subject}`),
            h("div", { class: "row" }, h("span", { class: "pill" }, c.priority), c.owner ? h("span", { class: "muted" }, c.owner) : null,
              ...c.labels.map(l => h("span", { class: "pill" }, l)), waits.length ? h("span", { class: "muted" }, "waits on " + waits.map(d => "#" + d).join(", ")) : null),
            move);
        }));
    });
    body.append(h("div", { class: "kanban" }, ...cols));
  },
  async session(body) {
    if (!session) return body.append(h("p", { class: "muted" }, "Open a session first."));
    const s = await json(`/v1/sessions/${session}?limit=1`);
    const ta = h("textarea", { rows: 5, placeholder: "Extra instructions for this session (system prompt addition)" });
    ta.value = s.agent.instructions || "";
    body.append(
      h("div", { class: "card grid" }, h("b", {}, "Instructions"), ta,
        h("div", { class: "row" }, h("button", { onclick: async () => { await post(`/v1/sessions/${session}`, { instructions: ta.value }, "PATCH"); toast(body, "saved"); } }, "Save"))),
      h("div", { class: "card grid" }, h("b", {}, "Context"),
        h("div", { class: "row" },
          h("button", { onclick: async () => { await post(`/v1/sessions/${session}/compact`); toast(body, "compaction started"); } }, "Compact"),
          h("button", { onclick: async () => { if (confirm("Start a fresh context? History stays stored.")) { await post(`/v1/sessions/${session}/reset`); closePanel(); openSession(session); } } }, "Reset context")),
        h("span", { class: "muted" }, "cwd: " + (s.agent.cwd || "(default)"))),
      h("div", { class: "card" }, h("b", {}, `Tools (${s.agent.tools.length})`), h("pre", {}, s.agent.tools.join(", "))),
    );
  },
  async agents(body) {
    if (!session) return body.append(h("p", { class: "muted" }, "Open a session first."));
    const s = await json(`/v1/sessions/${session}?limit=1`);
    if (!s.children.length) return body.append(h("p", { class: "muted" }, "This session has not spawned subagents. Ask Luna to delegate with delegate_task."));
    for (const c of s.children) {
      const st = await json(`/v1/sessions/${c.id}?limit=1`).catch(() => null);
      body.append(h("div", { class: "card" }, h("div", { class: "row" },
        h("span", { class: "grow" }, `#${c.id} `, c.task),
        h("button", { onclick: () => { closePanel(); openSession(c.id); } }, "Open"),
        h("button", { onclick: async () => { await api(`/v1/sessions/${c.id}/abort`, { method: "POST" }); toast(body, "stopped " + c.id); } }, "Stop")),
        st?.usage ? h("span", { class: "muted" }, Object.keys(st.usage.models).join(", ")) : null));
    }
  },
  async memory(body) {
    const q = h("input", { placeholder: "search", value: panelState.q || "" });
    const list = h("div", { class: "grid" });
    const load = async () => {
      panelState.q = q.value;
      const r = await json("/v1/memory?q=" + encodeURIComponent(q.value)).catch((e) => ({ error: e.message }));
      list.replaceChildren();
      if (r.error) return list.append(h("p", { class: "muted" }, r.error));
      if (!r.items.length) list.append(h("p", { class: "muted" }, "Nothing stored."));
      for (const m of r.items) list.append(h("div", { class: "card" },
        h("div", { class: "row" }, h("span", { class: "pill" }, m.kind), h("b", { class: "grow" }, m.key || "#" + m.id), h("span", { class: "muted" }, new Date(m.updated).toLocaleDateString()),
          h("button", { onclick: async () => { if (confirm("Forget this?")) { await api(`/v1/memory/${m.id}`, { method: "DELETE" }); load(); } } }, "Forget")),
        h("pre", {}, m.content)));
    };
    q.oninput = () => { clearTimeout(q.t); q.t = setTimeout(load, 250); };
    const key = h("input", { placeholder: "key (optional, e.g. user.timezone)" }), content = h("textarea", { rows: 2, placeholder: "fact or note" });
    body.append(h("div", { class: "card grid" }, h("b", {}, "Remember"), key, content,
      h("div", { class: "row" }, h("button", { onclick: async () => { try { await post("/v1/memory", { content: content.value, key: key.value.trim() || undefined }); content.value = ""; key.value = ""; load(); } catch (e) { toast(body, e.message); } } }, "Save"))), q, list);
    load();
  },
  async mcp(body) {
    const r = await json("/v1/mcp").catch((e) => ({ error: e.message }));
    if (r.error) return body.append(h("p", { class: "muted" }, r.error));
    const name = h("input", { placeholder: "name (letters, digits, _ -)" });
    const tr = h("select", {}, h("option", { value: "http" }, "http (Streamable HTTP)"), h("option", { value: "sse" }, "sse"), h("option", { value: "stdio" }, "stdio (local command)"));
    const target = h("input", { placeholder: "https://host/mcp" });
    const args = h("input", { placeholder: "args, space separated" });
    const secrets = h("textarea", { rows: 2, placeholder: "headers (Authorization: Bearer ...), one per line" });
    const defer = h("input", { type: "checkbox", checked: "checked" });
    const sync = () => {
      const stdio = tr.value === "stdio";
      target.placeholder = stdio ? "command, e.g. npx" : "https://host/mcp";
      args.style.display = stdio ? "" : "none";
      secrets.placeholder = stdio ? "env vars, one per line: KEY=value" : "headers, one per line: Authorization: Bearer ...";
    };
    tr.onchange = sync; sync();
    const pairs = (text, sep) => Object.fromEntries(text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(sep); return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
    body.append(h("div", { class: "card grid" }, h("b", {}, "Add MCP server"), name, tr, target, args, secrets,
      h("label", { class: "row muted" }, defer, "Defer tools (load on demand with tool_search; keeps the prompt small)"),
      h("div", { class: "row" }, h("button", { onclick: async (ev) => {
        const b = { name: name.value.trim(), transport: tr.value, defer: defer.checked };
        if (tr.value === "stdio") { b.command = target.value.trim(); if (args.value.trim()) b.args = args.value.trim().split(/\s+/); const e = pairs(secrets.value, "="); if (Object.keys(e).length) b.env = e; }
        else { b.url = target.value.trim(); const hd = pairs(secrets.value, ":"); if (Object.keys(hd).length) b.headers = hd; }
        ev.target.disabled = true; toast(body, "connecting...");
        try { await post("/v1/mcp", b); refresh(); } catch (e) { ev.target.disabled = false; toast(body, e.message); }
      } }, "Connect and save"))));
    if (!r.servers.length) body.append(h("p", { class: "muted" }, "No MCP servers yet."));
    for (const s of r.servers) {
      const color = s.status === "connected" ? "var(--ok)" : s.status === "failed" ? "var(--err)" : "var(--dim)";
      body.append(h("div", { class: "card grid" },
        h("div", { class: "row" }, h("b", { class: "grow" }, s.name), h("span", { style: "color:" + color }, s.status), h("span", { class: "muted" }, s.transport + " · " + s.source)),
        h("span", { class: "muted" }, s.target),
        s.secretKeys.length ? h("span", { class: "muted" }, "secrets: " + s.secretKeys.join(", ") + " (hidden)") : null,
        s.error ? h("span", { style: "color:var(--err)" }, s.error) : null,
        s.tools.length ? h("details", {}, h("summary", { class: "muted" }, `${s.tools.length} tools${s.defer ? " (deferred)" : ""}`), h("pre", { class: "code" }, s.tools.join("\n"))) : null,
        s.source === "web" ? h("div", { class: "row" },
          h("button", { onclick: async () => { try { await post("/v1/mcp/" + encodeURIComponent(s.name), { enabled: !s.enabled }, "PATCH"); refresh(); } catch (e) { toast(body, e.message); } } }, s.enabled ? "Disable" : "Enable"),
          h("button", { onclick: async () => { if (confirm(`Remove MCP server "${s.name}"?`)) { try { await api("/v1/mcp/" + encodeURIComponent(s.name), { method: "DELETE" }); refresh(); } catch (e) { toast(body, e.message); } } } }, "Remove"))
          : h("span", { class: "muted" }, "From the config file; edit it there.")));
    }
    body.append(h("p", { class: "muted" }, "New sessions see changes at once; running sessions pick them up on their next turn."));
  },
  async providers(body) {
    const r = await json("/v1/providers").catch((e) => ({ error: e.message }));
    if (r.error) return body.append(h("p", { class: "muted" }, r.error));
    const cur = r.default ? r.default.provider + "/" + r.default.modelId : "";
    // default model (connected providers only)
    const dsel = h("select", {}, ...modelList.map((m) => h("option", { value: m.provider + "/" + m.id }, m.provider + " · " + (m.name || m.id))));
    if (cur && ![...dsel.options].some((o) => o.value === cur)) dsel.append(h("option", { value: cur }, cur));
    dsel.value = cur;
    body.append(h("div", { class: "card grid" }, h("b", {}, "Default model for new sessions and cron"),
      h("div", { class: "row" }, dsel, h("button", { onclick: async () => { const [provider, ...rest] = dsel.value.split("/"); try { await post("/v1/models/default", { provider, modelId: rest.join("/") }, "PUT"); await loadModels(); toast(body, "default saved"); } catch (e) { toast(body, e.message); } } }, "Save"))));
    const builtin = r.providers.filter((p) => !p.custom && p.id !== "faux");
    const custom = r.providers.filter((p) => p.custom);
    const card = (p) => {
      const key = h("input", { type: "password", placeholder: "API key", autocomplete: "off" });
      const status = p.connected ? h("span", { class: "pill ok" }, (p.via === "oauth" ? "subscription" : "key") + (p.source ? " · " + p.source : "")) : h("span", { class: "pill" }, p.error ? "error" : "not connected");
      return h("div", { class: "card grid" },
        h("div", { class: "row" }, h("b", { class: "grow" }, p.name), status, h("span", { class: "muted" }, p.models + " models")),
        p.error ? h("pre", {}, p.error) : null,
        p.oauth ? h("div", { class: "row" }, h("button", { onclick: async () => { try { loginBox(body, await post(`/v1/providers/${p.id}/login`, { type: "oauth" })); } catch (e) { toast(body, e.message); } } }, p.oauth.label || (p.oauth.subscription ? "Sign in with subscription" : "Sign in")), h("span", { class: "muted" }, p.oauth.name)) : null,
        p.apiKey ? h("div", { class: "row" }, key, h("button", { onclick: async () => { try { await post(`/v1/providers/${p.id}/key`, { key: key.value }, "PUT"); key.value = ""; await loadModels(); refresh(); } catch (e) { toast(body, e.message); } } }, "Save key")) : null,
        p.connected && p.source && /stored|OAuth/i.test(p.source) ? h("div", { class: "row" }, h("button", { onclick: async () => { if (confirm(`Remove the stored ${p.name} credential?`)) { await api(`/v1/providers/${p.id}/credential`, { method: "DELETE" }); await loadModels(); refresh(); } } }, "Disconnect")) : null,
        p.id === "anthropic" && p.oauth ? h("div", { class: "muted" }, "Note: Anthropic bills third-party apps on a Pro/Max login as extra usage, not plan limits. Check claude.ai/settings/usage.") : null);
    };
    body.append(h("b", {}, "Providers"), ...builtin.map(card));
    // custom
    const cid = h("input", { placeholder: "id, e.g. local-llama" }), cname = h("input", { placeholder: "display name (optional)" });
    const capi = h("select", {}, h("option", { value: "openai-completions" }, "OpenAI-compatible (chat completions)"), h("option", { value: "openai-responses" }, "OpenAI Responses API"), h("option", { value: "anthropic-messages" }, "Anthropic-compatible (messages)"));
    const curl = h("input", { placeholder: "base URL, e.g. http://192.168.1.10:8080/v1" }), ckey = h("input", { type: "password", placeholder: "API key (blank for none)", autocomplete: "off" });
    const cmodels = h("input", { placeholder: "model ids, comma separated (blank: auto-detect via /models)" });
    body.append(h("b", {}, "Custom API"), ...custom.map((p) => h("div", { class: "card grid" },
      h("div", { class: "row" }, h("b", { class: "grow" }, p.name), h("span", { class: "pill " + (p.connected ? "ok" : "") }, p.def.api), h("span", { class: "muted" }, p.models + " models"),
        h("button", { onclick: async () => { if (confirm(`Remove provider ${p.id}?`)) { try { await api(`/v1/providers/custom/${p.id}`, { method: "DELETE" }); await loadModels(); refresh(); } catch (e) { toast(body, e.message); } } } }, "Remove")),
      h("div", { class: "muted" }, p.def.baseUrl + " · " + p.def.models.map((m) => m.id).join(", ")))),
      h("div", { class: "card grid" }, h("b", {}, "Add custom provider"), cid, cname, capi, curl, ckey, cmodels,
        h("div", { class: "row" }, h("button", { onclick: async (ev) => {
          ev.target.disabled = true;
          try {
            const models = cmodels.value.split(",").map((s) => s.trim()).filter(Boolean);
            await post("/v1/providers/custom", { id: cid.value.trim(), name: cname.value.trim(), api: capi.value, baseUrl: curl.value.trim(), key: ckey.value, models });
            await loadModels(); refresh();
          } catch (e) { toast(body, e.message); ev.target.disabled = false; }
        } }, "Add"))));
  },
  async skills(body) {
    const r = await json("/v1/skills").catch((e) => ({ error: e.message }));
    if (r.error) return body.append(h("p", { class: "muted" }, r.error));
    if (!r.skills.length) body.append(h("p", { class: "muted" }, "No skills yet. Luna creates them with skill_propose, or drop SKILL.md files into the skills directory."));
    for (const s of r.skills) {
      const pre = h("pre", { hidden: "" });
      const card = h("div", { class: "card" },
        h("div", { class: "row" }, h("b", { class: "grow" }, s.name),
          h("button", { onclick: async () => { if (pre.hidden) { const d = await json("/v1/skills/" + encodeURIComponent(s.name)); pre.textContent = d.body + (d.files.length ? "\n\nfiles: " + d.files.join(", ") : ""); } pre.hidden = !pre.hidden; } }, "View")),
        h("div", { class: "muted" }, s.description), s.tools.length ? h("div", { class: "muted" }, "tools: " + s.tools.join(", ")) : null, pre);
      body.append(card);
    }
  },
};
// ---- providers panel ----
function loginBox(body, login) {
  // Drives one interactive login: shows auth URLs / device codes / progress and answers prompts.
  const box = h("div", { class: "card grid" });
  body.prepend(box);
  let seen = -1, stop = false;
  const render = (l) => {
    box.replaceChildren(h("div", { class: "row" }, h("b", { class: "grow" }, "Login: " + l.providerId), h("span", { class: "pill " + (l.status === "done" ? "ok" : l.status === "running" ? "" : "error") }, l.status),
      l.status === "running" ? h("button", { onclick: async () => { stop = true; await api(`/v1/logins/${l.id}`, { method: "DELETE" }); refresh(); } }, "Cancel") : null));
    for (const e of l.events) {
      if (e.type === "auth_url") box.append(h("div", {}, h("a", { href: e.url, target: "_blank", rel: "noopener noreferrer" }, "Open sign-in page ↗"), e.instructions ? h("div", { class: "muted" }, e.instructions) : null));
      else if (e.type === "device_code") box.append(h("div", {}, "Code ", h("b", {}, e.userCode), " at ", h("a", { href: e.verificationUri, target: "_blank", rel: "noopener noreferrer" }, e.verificationUri)));
      else box.append(h("div", { class: "muted" }, e.message));
    }
    if (l.error) box.append(h("pre", {}, l.error));
    const p = l.prompt;
    if (p) {
      const send = async (v) => { try { await post(`/v1/logins/${l.id}/answer`, { seq: p.seq, value: v }); } catch (e) { toast(body, e.message); } };
      box.append(h("div", { class: "muted" }, p.message));
      if (p.type === "select") box.append(h("div", { class: "row" }, ...p.options.map((o) => h("button", { title: o.description || "", onclick: () => send(o.id) }, o.label))));
      else {
        const inp = h("input", { type: p.type === "secret" ? "password" : "text", placeholder: p.placeholder || "" });
        box.append(inp, h("div", { class: "row" }, h("button", { onclick: () => send(inp.value) }, "Submit")));
        if (p.type === "manual_code") box.append(h("div", { class: "muted" }, "On another device the browser cannot reach the callback. After you sign in, copy the final URL from the address bar (or the code shown) and paste it here."));
      }
    }
  };
  const tick = async () => {
    if (stop || currentPanel !== "providers") return;
    const l = await json(`/v1/logins/${login.id}`).catch(() => null);
    if (!l) return;
    const sig = JSON.stringify([l.status, l.events.length, l.prompt?.seq, l.error]);
    if (sig !== seen) { seen = sig; render(l); }
    if (l.status === "running") setTimeout(tick, 1000);
    else { await loadModels(); if (l.status === "done") setTimeout(refresh, 800); }
  };
  render(login); tick();
}
const DESCRIPTIONS = {
  projects: "Named working directories for new conversations.",
  board: "Cards shared by you and the sessions in the selected project.",
  conversation: "Manage the stored conversation. Changes apply across browsers and survive a restart.",
  session: "Instructions, context, and tools for this conversation.",
  agents: "Delegated work in this conversation.", cron: "Manage scheduled prompts and inspect recent runs.",
  memory: "Search, save, and remove persistent facts.", skills: "Browse the instructions available to Luna.",
  providers: "Connect accounts and choose your default model.", mcp: "Connect external tools and manage their access."
};
const panelState = {};
export let currentPanel = null;
const TITLES = { conversation: "Manage conversation", projects: "Projects", board: "Project board", session: "Session", agents: "Subagents", cron: "Cron jobs", memory: "Memory", skills: "Skills", providers: "Model providers", mcp: "MCP servers" };
export async function openPanel(name) {
  if (name === "settings") { closePanel(); return openSettingsScreen(); }
  if (name === "analytics") { closePanel(); return openAnalyticsScreen(); }
  if (name === "cron") { closePanel(); return openCronScreen(); }
  if (!closeSettingsScreen()) return;
  returnFocus = document.activeElement;
  setDrawer(false);
  currentPanel = name; boardEditing = false;
  $("panel").classList.toggle("wide", name === "board");
  $("pdesc").textContent = DESCRIPTIONS[name];
  $("ptitle").textContent = TITLES[name];
  $("panel").classList.add("open");
  $("side").inert = true; $("main").inert = true; $("cron-screen").inert = true; $("analytics-screen").inert = true; $("settings-screen").inert = true;
  $("pclose").focus();
  await refresh();
}
export async function refresh() {
  const body = $("pbody"); body.replaceChildren();
  const name = currentPanel;
  const content = h("div", { class: "grid" });
  body.append(h("p", { class: "muted", role: "status" }, "Loading…"));
  try {
    await panels[name](content);
    if (currentPanel !== name) return;
    for (const field of content.querySelectorAll("input[placeholder],textarea[placeholder],select")) {
      if (field.closest("label") || field.closest(".kanban") || field.type === "hidden") continue;
      const text = field.getAttribute("aria-label") || field.placeholder || ({ http: "Transport", "openai-completions": "API format" }[field.value]) || "Model";
      const label = h("label", { class: "field-label" }, h("span", {}, text));
      field.before(label); label.append(field);
    }
    body.replaceChildren(...content.children);
  } catch (e) { if (e.message !== "unauthorized") body.append(h("p", { class: "msg err" }, e.message)); }
}
export function closePanel() {
  if (!currentPanel) return;
  $("panel").classList.remove("open"); currentPanel = null;
  $("main").inert = false; $("cron-screen").inert = false; $("analytics-screen").inert = false; $("settings-screen").inert = false; $("side").inert = matchMedia(MOBILE).matches;
  if (returnFocus?.isConnected && !returnFocus.closest("[inert]")) returnFocus.focus();
  else if (settingsOpen) $("settings-menu")?.focus();
  else if (analyticsOpen) $("analytics-menu")?.focus();
  else if (cronOpen) $("cron-menu")?.focus();
  else $("menu").offsetParent ? $("menu").focus() : $("more").focus();
}
function toast(body, text) { const t = h("div", { class: "muted" }, text); body.prepend(t); setTimeout(() => t.remove(), 2500); }
$("pclose").onclick = closePanel;
$("panel").onclick = (e) => { if (e.target === $("panel")) closePanel(); };
for (const b of document.querySelectorAll("[data-panel]")) b.onclick = () => openPanel(b.dataset.panel);
