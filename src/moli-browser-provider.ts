// Moli (https://github.com/lexmount/moli): a headless agent browser engine. Luna starts `moli serve` on a loopback port and drives it
// over CDP with the shared Playwright provider. Moli builds layout on demand, so geometry is zero until a render has happened.
import { createPlaywrightBrowserProvider } from "./chromium-browser-provider.js";
import type { BrowserProvider } from "./browser-tools.js";

export interface MoliOptions { executablePath?: string; profileDir?: string }
const START_MS = 15_000;

type MoliProcess = ReturnType<typeof Bun.spawn>;

const freePort = () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  void probe.stop(true);
  return Promise.resolve(port);
};
async function waitForPort(port: number, child: MoliProcess, output: () => string) {
  const end = Date.now() + START_MS;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`Moli exited with code ${child.exitCode}. ${output().trim().slice(-500)}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* not ready */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Moli did not start in time.");
}

export function createMoliBrowserProvider(options: () => MoliOptions): BrowserProvider & { dispose(): Promise<void> } {
  let child: MoliProcess | undefined;
  return createPlaywrightBrowserProvider({
    async start() {
      const { executablePath, profileDir } = options();
      if (!executablePath) throw new Error("Set browser.providers.moli.executablePath to the Moli binary.");
      const { chromium } = await import("playwright").catch(() => { throw new Error("Playwright is not installed. Run bun install on this machine."); });
      const port = await freePort();
      // Layout and images are required for geometry, screenshots and visible-element checks. The child gets no Luna secrets.
      const args = ["serve", "--host", "127.0.0.1", "--port", String(port), "--layout", "--resource", "--log-level", "warn", ...(profileDir ? ["--profile-dir", profileDir] : [])];
      let log = "";
      const proc = Bun.spawn([executablePath, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: "C.UTF-8" },
      });
      const appendStream = async (stream: ReadableStream<Uint8Array> | null) => {
        if (!stream) return;
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) log = (log + decoder.decode(value, { stream: true })).slice(-4000);
          }
        } catch { /* stream closed or errored */ }
      };
      void appendStream(proc.stdout as ReadableStream<Uint8Array> | null);
      void appendStream(proc.stderr as ReadableStream<Uint8Array> | null);
      child = proc;
      const reap = () => { if (proc.exitCode === null) proc.kill("SIGTERM"); };
      process.once("exit", reap); void proc.exited.finally(() => process.off("exit", reap));
      try {
        await waitForPort(port, proc, () => log);
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        return { browser, context: await browser.newContext() };
      } catch (error) { proc.kill("SIGTERM"); child = undefined; throw error; }
    },
    async stop() {
      const proc = child; child = undefined;
      if (!proc || proc.exitCode !== null) return;
      proc.kill("SIGTERM");
      await new Promise<void>(resolve => {
        const t = setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 5000);
        proc.exited.then(() => { clearTimeout(t); resolve(); }, () => { clearTimeout(t); resolve(); });
      });
    },
    // A 1x1 screenshot makes Moli refresh layout. Without it, interactive elements get no snapshot ref and have zero geometry.
    async prepare(page) { await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1, height: 1 } }); },
  });
}
