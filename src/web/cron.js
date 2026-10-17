/* Cron is a full workspace page. History is fetched only after it is opened. */
window.createCronScreen = function ({ root, h, json, post, markdown, onContinue, onClose, onUnread }) {
  const PAGE = 20;
  const policies = { always: "Every run", changes: "Only when output changes", failures: "Failures only" };
  let opened = false, epoch = 0, view = "reports", selectedJob = "", selectedStatus = "";
  let snapshot = { jobs: [], timezone: "" }, pending = false, loading = false, badgeLoading = false, suspended = false;
  let historyRequest = 0, historyFetching = false;
  let viewVersion = 0, historyLoaded = false, historyMore = false, latestMore = false;
  let latest = [], historical = [], editor = null, pollTimer, badgeTimer;
  const expanded = new Set();
  const status = h("p", { class: "muted", role: "status", "aria-live": "polite" });
  const title = h("h1", {}, "Cron");
  const tabs = h("nav", { class: "cron-tabs", "aria-label": "Cron sections" });
  const tabButtons = new Map();
  for (const name of ["reports", "jobs", "runs"]) {
    const button = h("button", { type: "button", onclick: () => selectView(name), "aria-pressed": String(view === name) }, name[0].toUpperCase() + name.slice(1));
    tabButtons.set(name, button); tabs.append(button);
  }
  const header = h("header", {}, title, h("span", { class: "grow" }), h("button", { type: "button", onclick: onClose }, "Back to chat"));
  const jobSelect = h("select", { "aria-label": "Job", onchange: () => { selectedJob = jobSelect.value; resetLists(); load(); } });
  const statusSelect = h("select", { "aria-label": "Status", onchange: () => { selectedStatus = statusSelect.value; resetLists(); load(); } },
    h("option", { value: "" }, "Active and recent failures"), h("option", { value: "running" }, "Running"), h("option", { value: "ok" }, "Success"), h("option", { value: "error" }, "Failed"));
  const filters = h("div", { class: "row" }, h("label", {}, "Job", jobSelect), h("label", {}, "Status", statusSelect));
  const editorHost = h("div");
  const toolbar = h("div", { class: "row" });
  const list = h("div", { class: "grid", "data-cron-list": "latest" });
  const latestButton = h("button", { type: "button", onclick: () => loadMore(false) }, "Load more");
  const historyList = h("div", { class: "grid", "data-cron-list": "history" });
  const historyButton = h("button", { type: "button", onclick: () => loadMore(true) }, "Load more history");
  const history = h("details", { class: "cron-history" }, h("summary", {}, "Show history"), historyList, historyButton);
  history.ontoggle = () => { if (history.open && opened && !historyLoaded && !historyFetching) loadHistory(); };
  const content = h("div", { class: "cron-content" }, filters, toolbar, editorHost, list, latestButton, history);
  root.replaceChildren(header, tabs, status, content);

  function message(text, error = false) { status.textContent = text; status.className = error ? "cron-error" : "muted"; }
  function setUnread(count) { onUnread(count); }
  function date(value) { return value ? new Date(value).toLocaleString() : "—"; }
  function field(label, control) { control.setAttribute("aria-label", label); return h("label", { class: "field-label" }, h("span", {}, label), control); }
  function disabled(button, yes) { button.disabled = yes; return button; }
  function button(text, action, off = false) {
    return disabled(h("button", { type: "button", onclick: e => mutate(e.currentTarget, action) }, text), off);
  }
  async function mutate(control, action) {
    if (pending) return;
    pending = true; control.disabled = true; message("");
    try { await action(); }
    catch (e) { message(e.message || String(e), true); }
    finally { pending = false; if (control.isConnected) control.disabled = false; }
  }
  function updateFilters() {
    // Rebuild options only when jobs change, never replace the focused select.
    const jobs = new Map(snapshot.jobs.map(j => [String(j.id), j.name]));
    for (const run of [...latest, ...historical]) if (!jobs.has(String(run.jobId))) jobs.set(String(run.jobId), run.jobName + " (deleted)");
    if (selectedJob && !jobs.has(selectedJob)) jobs.set(selectedJob, "Job #" + selectedJob + " (deleted)");
    const sig = JSON.stringify([...jobs]);
    if (jobSelect.dataset.options !== sig) {
      jobSelect.replaceChildren(h("option", { value: "" }, "All jobs"), ...[...jobs].map(([id, name]) => h("option", { value: id }, name)));
      jobSelect.dataset.options = sig; jobSelect.value = selectedJob;
    }
  }
  function resetLists() {
    viewVersion++; historyRequest++; historyFetching = false; latest = []; historical = []; historyLoaded = false; latestMore = historyMore = false;
    history.open = false; list.replaceChildren(); historyList.replaceChildren();
    latestButton.hidden = historyButton.hidden = true;
  }
  function selectView(next) {
    if (view === next) return;
    view = next; resetLists(); message("");
    if (editor) editor.hidden = view !== "jobs";
    renderLayout(); load();
  }
  function renderLayout() {
    for (const [name, control] of tabButtons) {
      control.setAttribute("aria-pressed", String(name === view));
      control.setAttribute("aria-selected", String(name === view));
    }
    filters.hidden = view === "jobs"; statusSelect.parentElement.hidden = view !== "runs";
    history.hidden = view === "jobs"; latestButton.hidden = !latestMore || view === "jobs";
    historyButton.hidden = !historyMore;
    if (view === "jobs") {
      if (!toolbar.firstChild) toolbar.append(button("New job", () => showEditor()));
    } else toolbar.replaceChildren();
    toolbar.hidden = view !== "jobs";
    if (editor) editor.hidden = view !== "jobs";
  }
  function query(isHistory, before, limit = PAGE) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (isHistory) q.set("history", "1");
    if (selectedJob) q.set("jobId", selectedJob);
    if (view === "runs" && selectedStatus) q.set("status", selectedStatus);
    if (before) q.set("before", String(before));
    return `/v1/cron/${view === "reports" ? "reports" : "runs"}?${q}`;
  }
  function rows(data) { return view === "reports" ? data.reports : data.runs; }
  async function fetchRange(isHistory, count, e, v) {
    let result = [], data, page = [];
    do {
      data = await json(query(isHistory, result.at(-1)?.id, Math.min(100, Math.max(PAGE, count - result.length))));
      if (!valid(e, v)) return { items: [], more: false };
      page = rows(data); result.push(...page);
    } while (result.length < count && page.length === 100);
    return { items: result, more: page.length >= PAGE, unreadCount: data.unreadCount };
  }
  function valid(e, v) { return opened && epoch === e && viewVersion === v; }
  async function load() {
    if (!opened || suspended || document.hidden) return;
    const e = epoch, v = viewVersion, currentView = view;
    // A view switch may start a fresh request; older results are fenced by viewVersion.
    const ticket = ++load.sequence; loading = true;
    try {
      const summary = await json("/v1/cron?summary=1");
      if (!valid(e, v) || ticket !== load.sequence) return;
      snapshot = summary; setUnread(summary.unreadCount); updateFilters();
      if (currentView === "jobs") {
        reconcile(list, snapshot.jobs, jobCard); latestMore = false;
      } else {
        const data = await fetchRange(false, Math.max(PAGE, latest.length), e, v);
        if (!valid(e, v) || ticket !== load.sequence) return;
        latest = data.items; latestMore = data.more;
        // Full refreshes retain pages the user already opened.
        reconcile(list, latest, run => runCard(run, currentView === "reports"));
        if (currentView === "reports") setUnread(data.unreadCount);
        if (history.open && historyLoaded) await refreshHistory(e, v, ticket);
      }
      if (valid(e, v)) { updateFilters(); renderLayout(); }
    } catch (error) { if (valid(e, v) && ticket === load.sequence) message(error.message, true); }
    finally { if (ticket === load.sequence) loading = false; }
  }
  load.sequence = 0;
  async function refreshHistory(e, v, ticket) {
    const request = ++historyRequest;
    const data = await fetchRange(true, Math.max(PAGE, historical.length), e, v);
    if (!valid(e, v) || request !== historyRequest || ticket !== load.sequence) return;
    historical = data.items; historyMore = data.more;
    reconcile(historyList, historical, run => runCard(run, view === "reports"));
  }
  async function loadHistory() {
    const e = epoch, v = viewVersion, request = ++historyRequest;
    historyFetching = true;
    historyList.textContent = "Loading history…";
    try {
      const data = await json(query(true));
      if (!valid(e, v)) return;
      if (request !== historyRequest) return;
      historical = rows(data); historyLoaded = true; historyMore = historical.length === PAGE;
      historyList.replaceChildren(); reconcile(historyList, historical, run => runCard(run, view === "reports"));
      updateFilters(); historyButton.hidden = !historyMore;
    } catch (error) { if (valid(e, v) && request === historyRequest) { historyList.replaceChildren(button("Retry history", loadHistory)); message(error.message, true); } }
    finally { if (request === historyRequest) historyFetching = false; }
  }
  async function loadMore(isHistory) {
    if (pending) return;
    const control = isHistory ? historyButton : latestButton;
    await mutate(control, async () => {
      const ticket = ++load.sequence; loading = false;
      const request = ++historyRequest; historyFetching = false;
      const e = epoch, v = viewVersion, source = isHistory ? historical : latest;
      const data = await json(query(isHistory, source.at(-1)?.id));
      if (!valid(e, v)) return;
      if (ticket !== load.sequence || request !== historyRequest) return;
      const additional = rows(data);
      const combined = [...new Map([...source, ...additional].map(r => [r.id, r])).values()];
      if (isHistory) { historical = combined; historyMore = additional.length === PAGE; }
      else { latest = combined; latestMore = additional.length === PAGE; }
      reconcile(isHistory ? historyList : list, combined, run => runCard(run, view === "reports"));
      renderLayout();
    });
  }
  function reconcile(target, values, create) {
    // Stable, unchanged cards preserve focus, expansion, and scroll through polling.
    const existing = new Map([...target.children].filter(c => c.dataset.id).map(c => [c.dataset.id, c]));
    const keep = new Set();
    for (const value of values) {
      const key = String(value.id), sig = JSON.stringify(value); keep.add(key);
      let card = existing.get(key);
      if (!card || card.dataset.signature !== sig) {
        const replacement = create(value); replacement.dataset.id = key; replacement.dataset.signature = sig;
        if (card) card.replaceWith(replacement); card = replacement;
      }
      if (!card.isConnected || card.parentElement !== target) target.append(card);
    }
    for (const child of [...target.children]) if (!keep.has(child.dataset.id)) child.remove();
    // Sorting uses existing nodes, not replacement nodes.
    values.forEach((value, index) => { const card = [...target.children].find(c => c.dataset.id === String(value.id)); if (target.children[index] !== card) target.insertBefore(card, target.children[index] || null); });
    if (!values.length) target.append(h("p", { class: "muted" }, "No matching records."));
  }
  function runCard(run, report) {
    const key = (report ? "report-" : "run-") + run.id;
    const details = h("details", { class: "card cron-run" + (report && run.readAt === null ? " cron-unread" : ""), "data-run": run.id });
    const summary = h("summary", {}, h("span", { class: "row" },
      h("span", { class: "pill " + run.status }, run.status === "ok" ? "Success" : run.status === "error" ? "Failed" : "Running"),
      h("b", { class: "grow" }, run.jobName), h("span", { class: "muted" }, date(run.endedAt || run.startedAt)),
      report && run.readAt === null ? h("span", { class: "pill" }, "Unread") : null));
    const output = h("div", { class: "md" }); output.append(markdown([run.output, run.error ? "Error: " + run.error : null].filter(Boolean).join("\n\n") || "No output."));
    const metadata = h("div", { class: "grid muted" },
      h("span", {}, `Run #${run.id} · Started: ${date(run.startedAt)} · Finished: ${date(run.endedAt)}`),
      h("span", {}, `Duration: ${run.endedAt ? Math.max(0, (run.endedAt - run.startedAt) / 1000).toFixed(1) + " seconds" : "Running"} · Slot: ${date(run.slot)}`),
      h("span", {}, `Conversation: ${run.conversationId || "None (script or interrupted run)"} · Submission: ${run.submissionId || "None"}`));
    const actions = h("div", { class: "row" });
    if (report) actions.append(button(run.readAt === null ? "Mark read" : "Mark unread", async () => {
      if (run.readAt !== null) expanded.delete(key);
      await post(`/v1/cron/reports/${run.id}`, { read: run.readAt === null }, "PATCH"); await load();
    }));
    if (run.status !== "running") actions.append(button("Continue in chat", () => onContinue(run)));
    details.append(summary, metadata, output, actions);
    details.open = expanded.has(key);
    details.ontoggle = async () => {
      if (details.open) expanded.add(key); else expanded.delete(key);
      if (!details.open || !report || run.readAt !== null || pending || !details.isConnected) return;
      await mutate(details, async () => { await post(`/v1/cron/reports/${run.id}`, { read: true }, "PATCH"); await load(); });
    };
    return details;
  }
  function schedule(job) {
    if (job.intervalMs) return `Every ${job.intervalMs / 60000} minutes`;
    const aliases = { "@hourly": "Every hour", "@daily": "Every day at 00:00", "@midnight": "Every day at 00:00", "@weekly": "Every Sunday at 00:00", "@monthly": "First day of each month at 00:00", "@yearly": "Every January 1 at 00:00", "@annually": "Every January 1 at 00:00" };
    if (aliases[job.expr]) return aliases[job.expr];
    const parts = job.expr.trim().split(/\s+/), [min, hour, dom, month, dow] = parts;
    if (job.expr === "* * * * *") return "Every minute";
    if (/^\*\/\d+$/.test(min) && [hour, dom, month, dow].every(p => p === "*")) return `Every ${min.slice(2)} minutes`;
    if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && month === "*") {
      const time = hour.padStart(2, "0") + ":" + min.padStart(2, "0");
      if (dow === "*") return `Every day at ${time}`;
      if (dow === "1-5" || dow.toLowerCase() === "mon-fri") return `Weekdays at ${time}`;
      return `At ${time}, weekdays ${dow}`;
    }
    return `Minute ${min}; hour ${hour}; day ${dom}; month ${month}; weekday ${dow} (restricted day and weekday use OR)`;
  }
  function jobCard(job) {
    const running = job.lastRun?.status === "running";
    const actions = h("div", { class: "row" },
      button("Edit", () => showEditor(job)),
      button("Run now", async () => { await post(`/v1/cron/${job.id}/run`, {}); await load(); }, running),
      button(job.enabled ? "Pause" : "Resume", async () => { await post(`/v1/cron/${job.id}`, { enabled: !job.enabled }, "PATCH"); await load(); }),
      button("Delete", async () => { if (confirm(`Delete job "${job.name}"? Reports and run history will be kept.`)) { await post(`/v1/cron/${job.id}`, {}, "DELETE"); if (editor?.dataset.job === String(job.id)) dismissEditor(); await load(); } }, running),
      button("Reports", () => { selectedJob = String(job.id); jobSelect.value = selectedJob; selectView("reports"); }),
      button("Runs", () => { selectedJob = String(job.id); jobSelect.value = selectedJob; selectView("runs"); }));
    return h("article", { class: "card grid cron-job", "data-job": job.id },
      h("div", { class: "row" }, h("b", { class: "grow" }, job.name), h("span", { class: "pill" }, job.enabled ? "Enabled" : "Paused")),
      h("div", {}, schedule(job)), h("code", { class: "muted" }, job.intervalMs ? `Interval: ${job.intervalMs} ms` : job.expr),
      h("span", { class: "muted" }, `Timezone: ${snapshot.timezone || job.timezone} (server local time) · Next run: ${date(job.nextRun)}`),
      h("span", { class: "muted" }, `Last result: ${job.lastRun ? job.lastRun.status + " · " + date(job.lastRun.endedAt || job.lastRun.startedAt) : "No runs yet"}`),
      h("span", { class: "muted" }, `Reporting: ${policies[job.reportPolicy]}`),
      job.execution ? h("pre", {}, `Script: ${job.execution.command.join(" ")}\nDirectory: ${job.execution.cwd || "Server default"}`) : h("details", {}, h("summary", {}, "Prompt"), h("pre", {}, job.prompt)), actions);
  }
  function dismissEditor() { editor?.remove(); editor = null; }
  function showEditor(job) {
    dismissEditor();
    const name = h("input", { value: job?.name || "", required: true });
    const expr = h("input", { value: job?.expr || "@daily", required: true });
    const prompt = h("textarea", { rows: 5 }); prompt.value = job?.prompt || "";
    prompt.required = !job?.execution;
    const policy = h("select", {}, ...Object.entries(policies).map(([value, text]) => h("option", { value }, text))); policy.value = job?.reportPolicy || "always";
    const save = h("button", { type: "submit" }, "Save job");
    const form = h("form", { class: "card grid", "aria-label": job ? "Edit job" : "New job", "data-job": job?.id || "new" },
      h("h2", {}, job ? "Edit job" : "New job"), field("Job name", name),
      job?.intervalMs ? h("p", { class: "muted" }, `Interval: ${job.intervalMs / 60000} minutes. The imported interval is preserved.`) : field("Schedule", expr),
      h("p", { class: "muted" }, `Schedules use ${snapshot.timezone || "server local time"}. Use five cron fields or @daily, @hourly, @weekly.`),
      field("Prompt", prompt), field("Reporting", policy),
      h("p", { class: "muted" }, "Output changes compares exact text after trimming outer spaces. Every failure creates a report."),
      h("div", { class: "row" }, save, h("button", { type: "button", onclick: dismissEditor }, "Cancel")));
    form.onsubmit = e => { e.preventDefault(); mutate(save, async () => {
      const body = { name: name.value.trim(), prompt: prompt.value, reportPolicy: policy.value };
      if (!job?.intervalMs) body.expr = expr.value.trim();
      await post(job ? `/v1/cron/${job.id}` : "/v1/cron", body, job ? "PATCH" : "POST");
      dismissEditor(); await load(); message("Job saved.");
    }); };
    editor = form; editorHost.append(form); name.focus();
  }
  async function refreshBadge() {
    if (document.hidden || suspended || badgeLoading || document.getElementById("login")?.style.display === "flex") return;
    badgeLoading = true;
    try { const result = await json("/v1/cron/reports?limit=1"); setUnread(result.unreadCount); }
    catch (error) { if (opened && error.status !== 404) message(error.message, true); }
    finally { badgeLoading = false; }
  }
  function startTimers() {
    clearInterval(pollTimer); clearInterval(badgeTimer);
    if (suspended || document.hidden) return;
    pollTimer = setInterval(() => { if (opened && !pending && !loading) load(); }, 3000);
    badgeTimer = setInterval(refreshBadge, 15000);
  }
  document.addEventListener("visibilitychange", () => { startTimers(); if (!document.hidden) { refreshBadge(); if (opened) load(); } });
  window.addEventListener("pagehide", () => { suspended = true; epoch++; clearInterval(pollTimer); clearInterval(badgeTimer); });
  window.addEventListener("pageshow", () => { suspended = false; startTimers(); refreshBadge(); if (opened) load(); });
  return {
    open() { if (opened) return; opened = true; epoch++; root.hidden = false; renderLayout(); load(); if (history.open && !historyLoaded) loadHistory(); startTimers(); title.tabIndex = -1; title.focus(); },
    close() { opened = false; epoch++; viewVersion++; historyRequest++; historyFetching = false; root.hidden = true; loading = false; },
    refreshBadge() { refreshBadge(); startTimers(); },
  };
};
