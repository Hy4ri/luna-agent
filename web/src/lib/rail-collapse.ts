// Collapse state of session-rail cards, shared by all sessions and kept across reloads.
import { ref, watch } from "vue";

const KEY = "luna.rail.collapsed";

function load(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, boolean>;
  } catch { /* ignore */ }
  return {};
}

export const railCollapsed = ref<Record<string, boolean>>(load());
watch(railCollapsed, (val) => { try { localStorage.setItem(KEY, JSON.stringify(val)); } catch { /* ignore */ } }, { deep: true });
