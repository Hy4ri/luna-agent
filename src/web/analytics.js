/* Retained usage ledgers are authoritative. Dated assistant responses are a separate history view. */
window.createAnalyticsScreen = function ({ root, h, json, onClose, onMenu }) {
  let opened = false, generation = 0, selected = "", snapshot = null;
  const colors = ["#b5d9ad", "#8fb9d1", "#d5ba8d", "#bb9dcb"];
  const fields = [["input", "Uncached input"], ["output", "Output"], ["cacheRead", "Cache read"], ["cacheWrite", "Cache write"]];
  const full = n => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n || 0);
  const compact = n => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(n || 0);
  const usd = n => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(n || 0);
  const pct = n => n == null ? "Not reported" : (n * 100).toFixed(1) + "%";
  const when = value => value ? new Date(value).toLocaleString() : "Not reported";
  const status = h("p", { class: "a-status", role: "status", "aria-live": "polite" });
  const updated = h("span", { class: "a-updated" });
  const select = h("select", { "aria-label": "Analytics model", onchange: () => { selected = select.value; render(); } }, h("option", { value: "" }, "All models"));
  const refresh = h("button", { type: "button", onclick: load }, "Refresh");
  const menu = h("button", { id: "analytics-menu", type: "button", class: "icon-button", "aria-label": "Open navigation", "aria-controls": "side", onclick: onMenu });
  const icon = document.querySelector("#menu svg"); if (icon) menu.append(icon.cloneNode(true));
  const header = h("header", {}, menu, h("div", { class: "a-heading" }, h("div", { class: "eyebrow" }, "Workspace / Usage"), h("h1", { tabindex: "-1" }, "Analytics"), h("p", {}, "Model usage, token flow, and recorded cost.")), h("button", { type: "button", onclick: onClose }, "Back to chat"));
  const filters = h("div", { class: "a-filters" }, h("label", {}, "Model", select), refresh, updated);
  const content = h("div", { "data-analytics-content": "" });
  root.replaceChildren(header, filters, status, content);

  function rows() { return snapshot.models.filter(m => !selected || m.key === selected); }
  function stat(label, value, note, title) {
    return h("div", { class: "a-kpi" }, h("span", { class: "eyebrow" }, label), h("strong", { class: "a-value", ...(title ? { title } : {}) }, value), h("small", {}, note));
  }
  function card(title, subtitle, ...children) { return h("section", { class: "a-card" }, h("h2", {}, title), h("p", { class: "a-subtitle" }, subtitle), ...children); }
  function statRow(label, value) { return h("div", { class: "a-stat-row" }, h("span", {}, label), h("strong", {}, value)); }
  function legend() { return h("div", { class: "a-legend" }, ...fields.map(([, label], i) => h("span", {}, h("i", { class: "a-dot", style: `background:${colors[i]}`, "aria-hidden": "true" }), label))); }
  function composition(usage) {
    const sum = fields.reduce((n, [key]) => n + usage[key], 0);
    const bar = h("div", { class: "a-split", role: "img", "aria-label": fields.map(([key, label]) => `${label}: ${full(usage[key])}`).join(", ") });
    fields.forEach(([key, label], i) => bar.append(h("span", { style: `width:${sum ? usage[key] / sum * 100 : 0}%;background:${colors[i]}`, title: `${label}: ${full(usage[key])}` })));
    return card("Token composition", "Input excludes cache reads and writes. Subsets are not counted twice.", bar,
      h("div", { class: "a-breakdown" }, ...fields.map(([key, label]) => statRow(label, full(usage[key]))), statRow("Reasoning · part of output", usage.reasoning == null ? "Not reported" : full(usage.reasoning)), statRow("1h writes · part of cache write", usage.cacheWrite1h == null ? "Not reported" : full(usage.cacheWrite1h))), legend());
  }
  function svg(tag, attributes, text) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function timeline(models) {
    const days = new Map();
    for (const model of models) for (const day of model.daily) {
      let item = days.get(day.date);
      if (!item) { item = { date: day.date, responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; days.set(day.date, item); }
      item.responses += day.responses;
      for (const [key] of fields) item[key] += day.usage[key];
    }
    const sorted = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    // Keep the daily chart readable; the ledger totals above still include all retained history.
    const visible = sorted.slice(-30);
    const body = card("Daily token activity", "Last 30 active days · UTC · Dated assistant responses only; compaction attempts are not included.");
    if (!visible.length) { body.append(h("p", { class: "a-empty" }, "No dated response history is available.")); return body; }
    const max = Math.max(1, ...visible.map(d => fields.reduce((n, [key]) => n + d[key], 0)));
    const chart = svg("svg", { viewBox: "0 0 640 235", class: "a-chart", role: "img", "aria-label": "Daily token activity: stacked input, output, cache read and cache write tokens" });
    const left = 56, top = 12, height = 168, width = 574;
    [0, 0.5, 1].forEach(r => {
      const y = top + height * (1 - r);
      chart.append(svg("line", { x1: left, y1: y, x2: 632, y2: y, stroke: "var(--line)", "stroke-dasharray": "3 5" }), svg("text", { x: left - 9, y: y + 4, "text-anchor": "end" }, compact(max * r)));
    });
    const step = width / visible.length;
    visible.forEach((day, index) => {
      let y = top + height;
      const group = svg("g", {});
      group.append(svg("title", {}, `${day.date} UTC · ${full(day.responses)} responses\n${fields.map(([key, label]) => `${label}: ${full(day[key])}`).join("\n")}`));
      for (let i = 0; i < fields.length; i++) {
        const value = day[fields[i][0]], size = value / max * height;
        y -= size;
        group.append(svg("rect", { x: left + index * step + step * 0.17, y, width: step * 0.66, height: size, fill: colors[i], rx: 1 }));
      }
      chart.append(group);
      if (index === 0 || index === visible.length - 1 || (visible.length > 8 && index % Math.ceil(visible.length / 5) === 0)) chart.append(svg("text", { x: left + index * step + step / 2, y: 207, "text-anchor": "middle" }, day.date.slice(5)));
    });
    body.append(chart, legend());
    const table = h("table", {}, h("caption", { class: "muted" }, "Daily values (UTC)"), h("thead", {}, h("tr", {}, ...["Date", "Responses", ...fields.map(([, label]) => label)].map(label => h("th", { scope: "col" }, label)))), h("tbody", {}, ...visible.map(d => h("tr", {}, h("td", {}, d.date), h("td", {}, full(d.responses)), ...fields.map(([key]) => h("td", {}, full(d[key])))))));
    body.append(h("details", {}, h("summary", {}, "View daily values"), h("div", { class: "a-scroll", tabindex: "0", "aria-label": "Daily token values" }, table)));
    return body;
  }
  function comparison(models) {
    const mode = h("select", { "aria-label": "Model comparison metric" }, h("option", { value: "totalTokens" }, "Total tokens"), h("option", { value: "cost" }, "Recorded cost"));
    const bars = h("div", { class: "a-bars" });
    const paint = () => {
      const value = m => mode.value === "cost" ? m.usage.cost.total : m.usage.totalTokens;
      const sorted = [...models].sort((a, b) => value(b) - value(a));
      const max = Math.max(0, ...sorted.map(value));
      bars.replaceChildren(...sorted.map(m => h("div", {}, h("div", { class: "a-bar-label" }, h("span", {}, m.model, h("span", { class: "muted" }, " · " + m.provider)), h("span", {}, mode.value === "cost" ? usd(value(m)) : compact(value(m)))), h("div", { class: "a-bar-track", role: "img", "aria-label": `${m.key}: ${mode.value === "cost" ? usd(value(m)) : full(value(m))}` }, h("div", { class: "a-bar-fill", style: `width:${max ? value(m) / max * 100 : 0}%` })))));
      if (!max) bars.append(h("p", { class: "a-empty" }, mode.value === "cost" ? "No nonzero cost is recorded. This does not mean usage was free." : "No tokens recorded."));
    };
    mode.onchange = paint; paint();
    return card("Model comparison", "Compare the models in the current selection.", h("label", {}, "Measure", mode), bars);
  }
  function modelTable(models) {
    const table = h("table", {}, h("thead", {}, h("tr", {}, ...["Model", "Total tokens", "Input", "Output", "Cache read", "Cache write", "Hit rate", "Cost · USD", "Responses"].map(name => h("th", { scope: "col" }, name)))), h("tbody", {}, ...models.map(m => h("tr", {}, h("td", {}, h("button", { type: "button", onclick: () => { selected = m.key; select.value = selected; render(); } }, m.model), h("small", {}, m.provider)), ...[full(m.usage.totalTokens), full(m.usage.input), full(m.usage.output), full(m.usage.cacheRead), full(m.usage.cacheWrite), pct(m.usage.cacheHitRate), usd(m.usage.cost.total), full(m.responses)].map(value => h("td", {}, value))))));
    return card("Model breakdown", "Select a model name for its full detail. Scroll the table to see every counter.", h("div", { class: "a-scroll", tabindex: "0", "aria-label": "Model usage table" }, table));
  }
  function costBreakdown(usage) {
    return card("Recorded cost", "USD estimates recorded with each response. Not an invoice or subscription charge.", h("div", { class: "a-breakdown" }, ...fields.map(([key, label]) => statRow(label, usd(usage.cost[key]))), statRow("Total", usd(usage.cost.total))), h("p", { class: "a-subtitle" }, "Zero can mean unpriced usage, a subscription adapter, or a zero rate."));
  }
  function detail(model) {
    const rates = h("div", { class: "a-breakdown" }, ...fields.map(([key, label]) => statRow(label, model.rates && model.rates[key] > 0 ? usd(model.rates[key]) : "Not priced")));
    return h("div", { class: "a-grid a-section" }, card("Response history", "Observed assistant messages, not all model calls.", h("div", { class: "a-breakdown" }, statRow("Responses", full(model.responses)), statRow("Error responses", full(model.errors)), statRow("Aborted responses", full(model.aborted)), statRow("Sessions with ledger usage", full(model.sessions)), statRow("First response", when(model.firstSeen)), statRow("Latest response", when(model.lastSeen)))), card("Current model rates", "USD per 1M tokens · Current catalog rates, not historical billing rates.", rates));
  }
  function render() {
    if (!snapshot) return;
    const models = rows(), usage = selected ? models[0]?.usage : snapshot.totals;
    if (!usage) { selected = ""; select.value = ""; return render(); }
    const responses = models.reduce((n, m) => n + m.responses, 0);
    const cacheTotal = usage.input + usage.cacheRead + usage.cacheWrite;
    content.replaceChildren(h("div", { class: "a-kpis" }, stat("Total tokens", compact(usage.totalTokens), `${full(responses)} observed responses`, full(usage.totalTokens)), stat("Recorded cost · USD", usd(usage.cost.total), "Estimate, not an invoice"), stat("Cache hit rate", pct(usage.cacheHitRate), cacheTotal ? `${full(usage.cacheRead)} / ${full(cacheTotal)} input tokens` : "No input tokens recorded"), stat(selected ? "Model sessions" : "Retained sessions", full(selected ? models[0].sessions : snapshot.sessions), selected ? models[0].provider : `${full(snapshot.models.length)} models · includes subagents`)));
    if (!snapshot.models.length) content.append(h("p", { class: "a-empty" }, "No model usage recorded yet. Usage will appear after a model response."));
    else {
      content.append(h("div", { class: "a-grid" }, timeline(models), composition(usage)), h("div", { class: "a-grid" }, comparison(models), costBreakdown(usage)), modelTable(models));
      if (selected) content.append(detail(models[0]));
    }
    if (!selected && snapshot.tools.length) {
      const table = h("table", {}, h("thead", {}, h("tr", {}, ...["Tool", "Input", "Output", "Cache read", "Cache write", "Total tokens", "Cost · USD"].map(label => h("th", { scope: "col" }, label)))), h("tbody", {}, ...snapshot.tools.map(t => h("tr", {}, h("td", {}, t.name), ...[t.usage.input, t.usage.output, t.usage.cacheRead, t.usage.cacheWrite, t.usage.totalTokens].map(v => h("td", {}, full(v))), h("td", {}, usd(t.usage.cost.total))))));
      content.append(h("div", { class: "a-section" }, card("Tool-reported usage", "Separate counters. Not added to model totals because usage can overlap.", h("div", { class: "a-scroll", tabindex: "0", "aria-label": "Tool usage table" }, table))));
    }
    content.append(h("details", { class: "a-notes" }, h("summary", {}, "How to read these numbers"), h("p", {}, snapshot.scope), h("ul", {}, ...snapshot.notes.map(note => h("li", {}, note))), h("p", {}, "Cache hit rate = cache read ÷ (uncached input + cache read + cache write). Uncached input is not proof of a cache miss.")));
  }
  async function load() {
    if (!opened) return;
    const own = ++generation;
    refresh.disabled = true; root.setAttribute("aria-busy", "true"); status.className = "a-status";
    status.textContent = snapshot ? "Updating usage…" : "Loading usage…";
    try {
      const next = await json("/v1/analytics");
      if (!opened || own !== generation) return;
      snapshot = next;
      if (selected && !next.models.some(m => m.key === selected)) selected = "";
      const signature = JSON.stringify(next.models.map(m => m.key));
      if (select.dataset.options !== signature) {
        select.replaceChildren(h("option", { value: "" }, "All models"), ...next.models.map(m => h("option", { value: m.key }, m.model + " · " + m.provider)));
        select.dataset.options = signature;
      }
      select.value = selected;
      updated.textContent = "Updated " + when(next.generatedAt);
      status.textContent = "All retained history · Model totals include compaction usage. Charts show dated responses only.";
      render();
    } catch (error) {
      if (opened && own === generation) { status.className = "a-status error"; status.textContent = (snapshot ? "Could not refresh. Showing the previous snapshot. " : "Could not load usage. ") + error.message + " Use Refresh to retry."; }
    } finally {
      if (opened && own === generation) { refresh.disabled = false; root.setAttribute("aria-busy", "false"); }
    }
  }
  return {
    open() { opened = true; load(); },
    close() { opened = false; generation++; refresh.disabled = false; root.setAttribute("aria-busy", "false"); },
  };
};
