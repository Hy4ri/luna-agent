// Browser and MCP services of an execution worker. Both come from the worker's own luna.config.json
// (LUNA_CONFIG, or ./luna.config.json in the directory the worker starts in): `browser` and `mcpServers`.
// Nothing here fakes a result. A worker without a browser or an MCP server reports that to main.
import { accessSync, constants } from "node:fs";
import type { BrowserCapability } from "./worker-protocol.js";
import { createRegistry } from "@earendil-works/pi-durable";
import type { BrowserProvider } from "./browser-tools.js";
import { createCamofoxBrowserProvider } from "./camofox-browser-provider.js";
import { createChromiumBrowserProvider } from "./chromium-browser-provider.js";
import { createMoliBrowserProvider } from "./moli-browser-provider.js";
import { loadConfig, type LunaConfig } from "./config.js";
import { McpManager } from "./mcp.js";

export interface WorkerToolDef { name: string; description?: string; inputSchema?: Record<string, unknown>; server: string }

export class WorkerServices {
  private cfg: LunaConfig | undefined;
  private mcp: Promise<McpManager> | undefined;
  private browserProvider: (BrowserProvider & { dispose?(): Promise<void> }) | undefined;
  constructor(private load: () => LunaConfig = () => loadConfig()) {}

  private config() { return this.cfg ??= this.load(); }

  private manager(): Promise<McpManager> {
    return this.mcp ??= (async () => {
      const mcp = new McpManager(createRegistry(), this.config().mcpServers);
      await mcp.start();
      return mcp;
    })();
  }

  browserCapability(): BrowserCapability {
    const { browser } = this.config();
    const provider = browser.provider;
    if (provider === "disabled") return { provider, configured: false, reason: "Browser tools are disabled in the worker configuration." };
    if (provider === "chromium" || provider === "moli") {
      if (provider === "chromium" && browser.providers.chromium.cdpUrl) return { provider, configured: true };
      const path = provider === "chromium" ? browser.providers.chromium.executablePath : browser.providers.moli.executablePath;
      if (!path) return { provider, configured: false, reason: `Set browser.providers.${provider}.executablePath to the worker's browser executable.` };
      try { accessSync(path, constants.X_OK); }
      catch { return { provider, configured: false, reason: "The configured browser executable is missing or not executable on this worker." }; }
    } else if (!this.config().mcpServers.some(server => server.name === browser.providers.camofox.mcpServer && server.enabled !== false)) {
      return { provider, configured: false, reason: "The worker's Camofox MCP server is not configured or enabled." };
    }
    return { provider, configured: true };
  }

  async browser(): Promise<BrowserProvider> {
    const { browser } = this.config();
    const capability = this.browserCapability();
    if (!capability.configured) throw new Error(`${capability.reason} Nothing ran. Configure the worker browser, then restart the worker. Do not retry until configuration changes.`);
    this.browserProvider ??= browser.provider === "chromium"
      ? createChromiumBrowserProvider(() => this.config().browser.providers.chromium)
      : browser.provider === "moli" ? createMoliBrowserProvider(() => this.config().browser.providers.moli)
      : createCamofoxBrowserProvider(() => this.config().browser.providers.camofox, await this.manager());
    return this.browserProvider;
  }

  async mcpList(): Promise<WorkerToolDef[]> {
    const mcp = await this.manager();
    return mcp.connections.flatMap(c => c.toolDefs.map(d => ({ name: String(d.name), description: d.description, inputSchema: d.inputSchema, server: c.name })));
  }

  async mcpCall(server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal) {
    return (await this.manager()).callTool(server, tool, args, signal);
  }

  async close() {
    await this.browserProvider?.dispose?.();
    const mcp = this.mcp; this.mcp = undefined;
    if (mcp) await (await mcp.catch(() => undefined))?.close();
  }
}
