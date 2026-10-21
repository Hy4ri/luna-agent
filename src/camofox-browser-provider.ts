// Camofox's MCP API is an adapter detail. Native browser tools keep one stable contract.
import type { McpManager } from "./mcp.js";
import { validateWebUrl } from "./web-tools.js";
import type { BrowserImage, BrowserProvider, BrowserTab } from "./browser-tools.js";

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function image(value: unknown): BrowserImage {
  if (!record(value) || !["image/png", "image/jpeg", "image/webp"].includes(String(value.mimeType)) || typeof value.data !== "string" || !value.data.length || value.data.length % 4 !== 0)
    throw new Error("Camofox returned an invalid screenshot.");
  const bytes = Buffer.from(value.data, "base64");
  if (bytes.toString("base64") !== value.data) throw new Error("Camofox returned invalid screenshot encoding.");
  const valid = value.mimeType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : value.mimeType === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid) throw new Error("Camofox returned screenshot data that does not match its image type.");
  return { data: value.data, mimeType: value.mimeType as BrowserImage["mimeType"] };
}
function decode(response: unknown, json: boolean) {
  if (!record(response)) throw new Error("Camofox returned a malformed MCP response.");
  if (response.isError === true) throw new Error("Camofox reported an error. Check the tab handle, element target and MCP connection.");
  const blocks: unknown[] = Array.isArray(response.content) ? response.content : [];
  const images = blocks.filter(b => record(b) && b.type === "image").map(image);
  if (images.length > 1) throw new Error("Camofox returned multiple screenshots for one operation.");
  let data: unknown = response.structuredContent;
  if (json && data === undefined) {
    const texts = blocks.filter(b => record(b) && b.type === "text");
    if (texts.length !== 1 || !record(texts[0]) || typeof texts[0].text !== "string") throw new Error("Camofox returned no single JSON result.");
    try { data = JSON.parse(texts[0].text); } catch { throw new Error("Camofox returned invalid JSON content."); }
  }
  if (json && !record(data)) throw new Error("Camofox returned a malformed result.");
  if (record(data) && (data.ok === false || data.error !== undefined || data.navigationOk === false || typeof data.httpStatus === "number" && data.httpStatus >= 400))
    throw new Error("Camofox could not complete the browser operation.");
  return { data: record(data) ? data : {}, image: images[0] };
}
const nonempty = (v: unknown): v is string => typeof v === "string" && !!v.trim();
function checkTabId(value: unknown) {
  // Camofox puts tab handles into REST paths. Reject path/query injection at the adapter boundary.
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid Camofox tab handle.");
}
function tab(data: Record<string, unknown>): BrowserTab {
  if (!nonempty(data.tabId) || !nonempty(data.url)) throw new Error("Camofox returned a malformed tab result.");
  checkTabId(data.tabId);
  validateWebUrl(data.url);
  return { tabId: data.tabId, url: data.url };
}
export function createCamofoxBrowserProvider(options: () => { mcpServer: string }, mcp: Pick<McpManager, "callTool">): BrowserProvider {
  async function call(tool: string, args: object, signal: AbortSignal, json = true) {
    signal.throwIfAborted();
    if ("tabId" in args) checkTabId(args.tabId);
    const result = await mcp.callTool(options().mcpServer, tool, Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)), signal);
    signal.throwIfAborted();
    return decode(result, json);
  }
  async function action(tool: string, args: object, signal: AbortSignal) {
    const { data } = await call(tool, args, signal);
    if (data.ok !== true) throw new Error("Camofox did not confirm the browser operation.");
  }
  return {
    async open(request, signal) { return tab((await call("camofox_create_tab", request, signal)).data); },
    async navigate(request, signal) {
      const { data } = await call("camofox_navigate", request, signal);
      const result = tab(data);
      if (result.tabId !== request.tabId) throw new Error("Camofox returned a different tab handle.");
      return result;
    },
    close: (request, signal) => action("camofox_close_tab", request, signal),
    click: (request, signal) => action("camofox_click", request, signal),
    type: (request, signal) => action("camofox_type", request, signal),
    scroll: (request, signal) => action("camofox_scroll", request, signal),
    async snapshot(request, signal) {
      const { data, image } = await call("camofox_snapshot", request, signal);
      if (!nonempty(data.url) || typeof data.snapshot !== "string" || data.hasMore !== undefined && typeof data.hasMore !== "boolean")
        throw new Error("Camofox returned a malformed page snapshot.");
      validateWebUrl(data.url);
      const hasMore = data.hasMore === true;
      const nextOffset = data.nextOffset == null ? undefined : data.nextOffset;
      if (nextOffset !== undefined && (!Number.isSafeInteger(nextOffset) || (nextOffset as number) < 0) || hasMore && (typeof nextOffset !== "number" || nextOffset <= (request.offset ?? 0)))
        throw new Error("Camofox returned invalid snapshot pagination.");
      if (data.totalChars !== undefined && (!Number.isSafeInteger(data.totalChars) || (data.totalChars as number) < 0 || hasMore && (nextOffset as number) >= (data.totalChars as number)))
        throw new Error("Camofox returned an invalid snapshot size.");
      return { tabId: request.tabId, url: data.url, content: data.snapshot, hasMore,
        ...(nextOffset !== undefined ? { nextOffset: nextOffset as number } : {}),
        ...(data.totalChars !== undefined ? { totalChars: data.totalChars as number } : {}), ...(image ? { image } : {}) };
    },
    async screenshot(request, signal) {
      const { image } = await call("camofox_screenshot", request, signal, false);
      if (!image) throw new Error("Camofox returned no screenshot image.");
      return image;
    },
  };
}
