// Search-only HTTP adapters. Options stay in each provider's configuration.
import type { LunaConfig } from "./config.js";
import { validateWebUrl, type WebProvider, type WebSearchResult } from "./web-tools.js";
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const SAFESEARCH = { off: "0", moderate: "1", on: "2" } as const;

async function getJson(label: string, url: URL, timeoutMs: number, signal: AbortSignal, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.any([signal, timeout]) });
  } catch (error) {
    signal.throwIfAborted();
    if (timeout.aborted) throw new Error(`${label} did not respond within ${timeoutMs} ms.`);
    throw new Error(`${label} is unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error(`${label} returned invalid JSON. For SearXNG, enable the json format in settings.yml.`); }
  if (!record(data)) throw new Error(`${label} returned a malformed response.`);
  return data;
}

// Rows with a missing title or a non-HTTP(S) URL are skipped, not fatal.
function rows(label: string, data: Record<string, unknown>, snippetKey: string): WebSearchResult[] {
  if (!Array.isArray(data.results)) throw new Error(`${label} returned malformed search results.`);
  return data.results.flatMap((row): WebSearchResult[] => {
    if (!record(row) || typeof row.url !== "string" || typeof row.title !== "string") return [];
    try { validateWebUrl(row.url); } catch { return []; }
    return [{ title: row.title, url: row.url, snippet: typeof row[snippetKey] === "string" ? row[snippetKey] : "" }];
  });
}

export function createSearxngWebProvider(options: () => LunaConfig["web"]["providers"]["searxng"], fetchImpl: typeof fetch = fetch): WebProvider {
  return {
    async search(request, signal) {
      const o = options();
      const url = new URL("search", o.url.endsWith("/") ? o.url : `${o.url}/`);
      url.search = new URLSearchParams({ q: request.query, format: "json", safesearch: SAFESEARCH[o.safesearch] }).toString();
      return rows("SearXNG", await getJson("SearXNG", url, o.timeoutMs, signal, fetchImpl), "content");
    },
  };
}

export function createFreeserpWebProvider(options: () => LunaConfig["web"]["providers"]["freeserp"], fetchImpl: typeof fetch = fetch): WebProvider {
  return {
    async search(request, signal) {
      const o = options();
      const url = new URL("api.php", o.url.endsWith("/") ? o.url : `${o.url}/`);
      url.search = new URLSearchParams({ index: "web", q: request.query, size: String(Math.min(request.count ?? 5, 100)) }).toString();
      const data = await getJson("FreeSerp", url, o.timeoutMs, signal, fetchImpl);
      if (data.ok === false) throw new Error(`FreeSerp reported an error${typeof data.error === "string" ? `: ${data.error}` : "."}`);
      return rows("FreeSerp", data, "snippet");
    },
  };
}
