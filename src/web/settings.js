// The validated config schema supplies every field. No second settings model is stored in the UI.
async function renderSettings(body, { h, json, post, loadModels, getModels, onSaved, initialTab = "general", onTabChange }) {
  await loadModels();
  let saved = await json("/v1/settings");
  let draft = structuredClone(saved.config);
  let baseline = JSON.stringify(draft);
  const groups = {
    general: ["dataDir", "cwd", "server", "busyInput"],
    models: ["provider", "model", "thinkingLevel", "subagents", "providers", "auxiliary"],
    context: ["instructions", "compaction"],
    tools: ["web", "browser", "processes", "mcpServers", "extensions", "skillDirs"],
    automation: ["cron", "improve"],
  };
  let activeTab = Object.hasOwn(groups, initialTab) ? initialTab : "general";
  const tabs = h("div", { class: "settings-tabs", role: "tablist", "aria-label": "Settings sections" });
  const tabButtons = new Map();
  function selectTab(id, notify = true) {
    if (!Object.hasOwn(groups, id)) id = "general";
    activeTab = id;
    redraw();
    if (notify) onTabChange?.(id);
  }
  for (const [id, title] of Object.entries({ general: "General", models: "Models", context: "Context", tools: "Tools", automation: "Automation" })) {
    const tab = h("button", { type: "button", role: "tab", id: "settings-tab-" + id, "data-settings-tab": id,
      "aria-controls": "settings-fields", onclick: () => selectTab(id) }, title);
    tab.onkeydown = e => {
      const ids = Object.keys(groups), index = ids.indexOf(activeTab);
      const next = e.key === "ArrowRight" ? (index + 1) % ids.length : e.key === "ArrowLeft" ? (index + ids.length - 1) % ids.length : e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : -1;
      if (next < 0) return;
      e.preventDefault(); selectTab(ids[next]); tabButtons.get(ids[next]).focus();
    };
    tabButtons.set(id, tab); tabs.append(tab);
  }
  const form = h("div", { class: "grid", id: "settings-fields", role: "tabpanel", tabindex: "0" });
  const status = h("p", { class: "muted", role: "status", "aria-live": "polite" });
  const titles = {
    auxiliary: "Auxiliary models", side_question: "Side questions",
    browser: "Browser tools", camofox: "Camofox",
    processes: "Background processes", retentionHours: "Completed output retention (hours)", maxOutputBytes: "Retained output per process (bytes)",
    web: "Web tools", searchProvider: "Search provider", extractProvider: "Extraction provider", ddgs: "DDGS", mcpServer: "MCP server name", backend: "Search backend", region: "Search region", safesearch: "Safe search",
    dataDir: "Data directory", cwd: "Working directory", provider: "Provider", model: "Model ID",
    thinkingLevel: "Thinking level", instructions: "Default instructions", providers: "Custom AI providers",
    subagents: "Subagents", extensions: "Extensions", skillDirs: "Extra skill directories", mcpServers: "MCP servers",
    cron: "Scheduled runs", improve: "Self-improvement", server: "HTTP server", notifyUrl: "Notification URL",
    runTimeoutMinutes: "Run timeout (minutes)", schedule: "Schedule (cron expression)", allowCommandBenchmarks: "Allow command benchmarks",
    host: "Host", port: "Port", id: "ID", name: "Name", api: "API format", baseUrl: "Base URL", models: "Models",
    contextWindow: "Context window (tokens)", maxTokens: "Maximum output tokens", reasoning: "Reasoning support", vision: "Image support",
    transport: "Transport", command: "Command", args: "Arguments", env: "Environment variables", url: "URL", headers: "Headers",
    busyInput: "Busy chat input", mode: "Mode", acknowledgements: "Show acknowledgements",
    compaction: "Automatic compaction", triggerPercent: "Context trigger (%)",
    enabled: "Enabled", defer: "Defer tools until search", timeoutMs: "Tool-call timeout (milliseconds)",
  };
  const additions = { providers: "provider", models: "model", mcpServers: "MCP server", skillDirs: "skill directory", args: "argument", env: "environment variable", headers: "header" };
  const label = path => ["web.providers", "browser.providers"].includes(path.join(".")) ? "Provider options" : path.join(".") === "processes.enabled" ? "Enable background command starts" : path.join(".") === "browser.provider" ? "Browser provider" : path.join(".") === "compaction.enabled" ? "Enable automatic compaction" : typeof path.at(-1) === "number" ? (additions[path.at(-2)] || "Item") + " " + (path.at(-1) + 1) : path.join(".") === "thinkingLevel" ? "Main thinking level"
    : path.join(".") === "subagents.thinkingLevel" ? "Subagent thinking level" : titles[path.at(-1)] || path.at(-1);
  const get = path => path.reduce((value, key) => value?.[key], draft);
  function set(path, value) {
    let target = draft;
    for (const key of path.slice(0, -1)) target = target[key] ??= {};
    if (value === undefined) delete target[path.at(-1)]; else Object.defineProperty(target, path.at(-1), { value, configurable: true, enumerable: true, writable: true });
    status.textContent = "Unsaved changes.";
  }
  const fieldLabel = (text, input) => h("label", { class: "field-label" }, h("span", {}, text), input);
  const button = (text, action) => h("button", { type: "button", onclick: action }, text);
  function seed(schema) {
    if (schema.default !== undefined) return structuredClone(schema.default);
    const variants = schema.anyOf || schema.oneOf;
    if (variants) return seed(variants.find(s => s.properties?.transport?.const === "http") || variants[0]);
    if (schema.const !== undefined) return schema.const;
    if (schema.enum) return schema.enum[0];
    if (schema.type === "array") return [];
    if (schema.type === "object") {
      const result = {};
      for (const key of schema.required || []) result[key] = seed(schema.properties[key]);
      return result;
    }
    return schema.type === "boolean" ? false : schema.type === "number" || schema.type === "integer" ? (schema.minimum ?? 1) : "";
  }
  // Restore expanded sections after adding or removing collection items.
  function redraw() {
    const open = new Set([...form.querySelectorAll("details[open][data-section]")].map(e => e.dataset.section));
    form.replaceChildren();
    const props = saved.schema.properties;
    for (const [id, tab] of tabButtons) {
      tab.setAttribute("aria-selected", String(id === activeTab));
      tab.tabIndex = id === activeTab ? 0 : -1;
    }
    form.setAttribute("aria-labelledby", "settings-tab-" + activeTab);
    if (activeTab === "models") {
      const main = h("section", { class: "card grid" }, h("h2", {}, "Main agent"), modelPicker(false));
      main.append(field(props.thinkingLevel, ["thinkingLevel"], false));
      main.append(h("p", { class: "muted" }, "Defaults apply to new chat sessions. Each model can limit its supported thinking levels."));
      form.append(main);
      const child = h("section", { class: "card grid" }, h("h2", {}, "Subagents"), modelPicker(true));
      for (const key of ["thinkingLevel", "cwd"]) child.append(field(props.subagents.properties[key], ["subagents", key], false));
      child.append(h("p", { class: "muted" }, "Unset values inherit from the parent. Applies to normal and forked children."));
      form.append(child);
    }
    for (const key of groups[activeTab].filter(k => !["provider", "model", "thinkingLevel", "subagents"].includes(k))) {
      const section = h("section", { class: "card grid", "data-section": key }, h("h2", {}, titles[key] || key), field(props[key], [key], (saved.schema.required || []).includes(key)));
      if (key === "busyInput") section.append(h("p", { class: "muted" }, "Applies now to all chats. Interrupt redirects the model; tools finish safely. Queue runs separate turns. Steer adds information at the next boundary. Use /queue, /steer, or /redirect for one message."));
      if (key === "compaction") section.append(h("p", { class: "muted" }, "Applies live to existing sessions. Running tool calls finish first. Emergency overflow recovery stays enabled."));
      if (key === "processes") section.append(h("p", { class: "muted" }, "Allows native background shell commands with the same host access as bash. Completion resumes the owning chat. Normal shutdown stops commands. Save, then restart Luna to apply changes."));
      if (key === "browser") section.append(h("p", { class: "muted" }, "Browser tools use the selected provider and its named MCP connection. Save, then restart Luna to apply routing changes."));
      if (key === "web") section.append(h("p", { class: "muted" }, "Search and extraction use separate provider selections. DDGS uses the named MCP connection and its protected credentials. Save, then restart Luna to apply routing changes."));
      form.append(section);
    }
    for (const section of form.querySelectorAll("details[data-section]")) if (open.has(section.dataset.section)) section.open = true;
  }
  function modelPicker(child) {
    const path = child ? ["subagents"] : [];
    const current = get(path);
    const select = h("select", { "aria-label": child ? "Subagent default model" : "Main default model" });
    select.append(h("option", { value: "" }, child ? "Inherit parent model" : "Runtime default"));
    const models = new Map(getModels().map(m => [m.provider + "/" + m.id, m.provider + " · " + (m.name || m.id)]));
    for (const provider of draft.providers) for (const m of provider.models) if (m.id) models.set(provider.id + "/" + m.id, provider.name + " · " + (m.name || m.id));
    const value = current.provider && current.model ? current.provider + "/" + current.model : "";
    if (value && !models.has(value)) models.set(value, value);
    for (const [value, name] of models) select.append(h("option", { value }, name));
    select.append(h("option", { value: "custom" }, "Custom provider and model ID"));
    select.value = value;
    const custom = h("div", { class: "grid" });
    custom.hidden = true;
    // Direct inputs also permit an endpoint/model that is not yet in the live model catalog.
    custom.append(field({ type: "string" }, [...path, "provider"], !child), field({ type: "string" }, [...path, "model"], false));
    select.onchange = () => {
      custom.hidden = select.value !== "custom";
      if (select.value === "custom") return;
      const [provider, ...model] = select.value.split("/");
      set([...path, "provider"], provider || (child ? undefined : "faux"));
      set([...path, "model"], model.length ? model.join("/") : undefined);
      for (const input of custom.querySelectorAll("input")) input.value = get(input.dataset.setting.split(".")) ?? "";
    };
    return h("div", { class: "grid" }, fieldLabel(child ? "Subagent default model" : "Main default model", select), custom);
  }
  function field(schema, path, required) {
    const key = path.at(-1), value = get(path), text = label(path);
    const attrs = { "data-setting": path.join("."), "aria-label": text };
    if (schema.anyOf || schema.oneOf) {
      const variants = schema.anyOf || schema.oneOf;
      const selected = variants.find(s => s.properties.transport.const === value?.transport) || variants[0];
      const select = h("select", { ...attrs, "data-setting": [...path, "transport"].join(".") },
        ...variants.map(s => h("option", { value: s.properties.transport.const }, s.properties.transport.const)));
      select.value = selected.properties.transport.const;
      select.onchange = () => {
        const next = seed(variants.find(s => s.properties.transport.const === select.value));
        for (const name of ["name", "enabled", "defer", "timeoutMs"]) if (value?.[name] !== undefined) next[name] = value[name];
        if (value?.transport !== "stdio" && select.value !== "stdio" && value?.url) { next.url = value.url; next.headers = value.headers; }
        set(path, next); redraw();
      };
      const group = h("div", { class: "grid" }, fieldLabel("Transport", select));
      for (const [name, child] of Object.entries(selected.properties)) if (name !== "transport") group.append(field(child, [...path, name], (selected.required || []).includes(name)));
      return group;
    }
    if (schema.type === "object" && schema.properties) {
      const group = h("div", { class: "grid" });
      if (path.join(".") === "browser.providers.camofox") group.append(h("h3", {}, "Camofox options"));
      if (path.join(".") === "web.providers.ddgs") group.append(h("h3", {}, "DDGS options"));
      for (const [name, child] of Object.entries(schema.properties)) group.append(field(child, [...path, name], (schema.required || []).includes(name)));
      return group;
    }
    if (schema.type === "object") {
      const group = h("div", { class: "grid" }, h("b", {}, text));
      for (const [name, entry] of Object.entries(value || {})) {
        const nameInput = h("input", { value: name, "aria-label": text + " key", autocomplete: "off" });
        nameInput.onchange = () => {
          const nextName = nameInput.value.trim();
          if (!nextName || nextName === "__proto__" || nextName === "constructor" || nextName === "prototype" || (nextName !== name && Object.hasOwn(get(path), nextName))) {
            status.textContent = "Use a unique, nonempty key."; nameInput.value = name; return;
          }
          const next = Object.fromEntries(Object.entries(get(path)).map(([k, v]) => [k === name ? nextName : k, v]));
          set(path, next); redraw();
        };
        const input = h("input", { type: "password", value: entry, "data-setting": [...path, name].join("."), "aria-label": text + " value", autocomplete: "new-password" });
        input.oninput = () => set([...path, name], input.value);
        group.append(h("div", { class: "grid card" }, fieldLabel("Key", nameInput), fieldLabel("Value (saved secrets stay hidden)", input),
          button("Remove " + name, () => { const next = { ...get(path) }; delete next[name]; set(path, next); redraw(); })));
      }
      group.append(button("Add " + additions[key], () => {
        const entries = { ...get(path) }; let n = 1; while (Object.hasOwn(entries, "VARIABLE_" + n)) n++;
        entries["VARIABLE_" + n] = ""; set(path, entries); redraw();
      }));
      return group;
    }
    if (schema.type === "array") {
      if (schema.items.enum) {
        return h("div", { class: "grid", "data-setting": path.join(".") }, ...schema.items.enum.map(option => {
          const check = h("input", { type: "checkbox", "aria-label": option }); check.checked = (value || []).includes(option);
          check.onchange = () => set(path, schema.items.enum.filter(v => v === option ? check.checked : (get(path) || []).includes(v)));
          return h("label", { class: "row" }, check, option);
        }));
      }
      const group = h("div", { class: "grid" });
      for (const [i, item] of (value || []).entries()) {
        const content = h("div", { class: "grid" }, field(schema.items, [...path, i], true),
          button("Remove " + (additions[key] || "item") + " " + (i + 1), () => { const next = [...get(path)]; next.splice(i, 1); set(path, next); redraw(); }));
        if (schema.items.type === "string") group.append(content);
        else {
          const section = h("details", { class: "card grid", "data-section": path.join(".") + "." + i },
            h("summary", {}, item.name || item.id || (additions[key] || "Item") + " " + (i + 1)), content);
          group.append(section);
        }
      }
      group.append(button("Add " + additions[key], () => { set(path, [...(get(path) || []), seed(schema.items)]); redraw(); }));
      return group;
    }
    if (schema.enum || (schema.type === "boolean" && !required)) {
      const options = schema.enum || [true, false];
      const select = h("select", attrs);
      if (!required) select.append(h("option", { value: "" }, key === "thinkingLevel" ? (path.length > 1 ? "Inherit parent thinking level" : "Model default") :
        ["enabled", "defer"].includes(key) ? "Default (enabled)" : schema.type === "boolean" ? "Default (off)" : "Not set"));
      for (const option of options) select.append(h("option", { value: String(option) }, schema.type === "boolean" ? option ? "Yes" : "No" : option));
      select.value = value === undefined ? "" : String(value);
      select.onchange = () => set(path, select.value === "" && !required ? undefined : schema.type === "boolean" ? select.value === "true" : select.value);
      return fieldLabel(text, select);
    }
    if (schema.type === "boolean") {
      const check = h("input", { ...attrs, type: "checkbox" }); check.checked = value ?? schema.default ?? false;
      check.onchange = () => set(path, check.checked);
      return h("label", { class: "row" }, check, text);
    }
    const number = schema.type === "number" || schema.type === "integer";
    const input = h(key === "instructions" ? "textarea" : "input", { ...attrs,
      ...(key === "instructions" ? { rows: 4 } : { type: number ? "number" : "text" }),
      ...(number ? { step: schema.type === "integer" ? "1" : "any", min: schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + (schema.type === "integer" ? 1 : 0.001) : undefined), max: schema.maximum } : {}),
      placeholder: required ? undefined : "Not set", autocomplete: "off" });
    input.value = value ?? "";
    input.oninput = () => set(path, input.value === "" && !required ? undefined : number ? Number(input.value) : input.value);
    return fieldLabel(text, input);
  }
  const save = h("button", { type: "button", "data-settings-save": "", onclick: async () => {
    save.disabled = true; form.inert = true; tabs.inert = true; reload.disabled = true;
    try {
      saved = await post("/v1/settings", { config: draft, revision: saved.revision }, "PUT");
      draft = structuredClone(saved.config); baseline = JSON.stringify(draft); await loadModels(); redraw(); onSaved?.();
      status.textContent = saved.restartRequired ? "Saved. Restart Luna to apply runtime changes." : "Settings saved. Compaction changes apply now. New sessions and subagents use the new defaults.";
    } catch (e) { status.textContent = e.message; }
    finally { save.disabled = false; form.inert = false; tabs.inert = false; reload.disabled = false; }
  } }, "Save settings");
  const reload = button("Reload", async () => {
    if (!confirm("Discard unsaved edits and reload settings?")) return;
    reload.disabled = true; save.disabled = true; form.inert = true; tabs.inert = true;
    try { saved = await json("/v1/settings"); draft = structuredClone(saved.config); baseline = JSON.stringify(draft); await loadModels(); redraw(); notice(); }
    catch (e) { status.textContent = e.message; }
    finally { reload.disabled = false; save.disabled = false; form.inert = false; tabs.inert = false; }
  });
  function notice() {
    status.textContent = saved.restartRequired ? "Saved. Restart Luna to apply runtime changes." : "Compaction changes apply live. Model defaults apply to new sessions and subagents. Other changes need a restart.";
  }
  body.append(tabs,
    h("details", { class: "settings-file" }, h("summary", {}, "Configuration file"),
      h("p", { class: "muted" }, saved.path),
      h("p", { class: "muted" }, "All tabs save to this file. Provider and MCP panels use the same file. Saved secret markers preserve existing values."),
      saved.environmentOverrides.length ? h("p", { class: "muted" }, "Environment overrides: " + saved.environmentOverrides.join(", ")) : null),
    form, h("p", { class: "muted" }, "Provider definitions, MCP connections, and runtime changes made here need a restart. Provider and MCP panels can apply connection changes live."),
    h("div", { class: "row" }, save, reload), status);
  redraw(); notice();
  return {
    selectTab,
    canLeave: () => JSON.stringify(draft) === baseline || confirm("Discard unsaved settings?"),
    isDirty: () => JSON.stringify(draft) !== baseline,
  };
}
