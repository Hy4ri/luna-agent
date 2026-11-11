// Startup recovery is deliberately independent of the agent runtime and its persistent stores.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bindRefusal, configDiagnostic, loadConfig, parseConfig, type LunaConfig } from "./config.js";

export async function loadDaemonConfig(token: string | undefined): Promise<LunaConfig> {
  try {
    const cfg = loadConfig();
    const refusal = bindRefusal(cfg.server.host, token);
    if (refusal) throw new Error(refusal);
    return cfg;
  } catch (error) {
    let message = configDiagnostic(error);
    const path = resolve(process.env.LUNA_CONFIG ?? join(homedir(), ".luna", "luna.config.json"));
    let raw: any;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { /* Invalid JSON has no usable bind settings. */ }
    // Salvage only independently validated listener fields, never agent/runtime policy.
    let host = "127.0.0.1", port = 8787, publicUrls: string[] = [];
    try { host = parseConfig({ server: { host: process.env.LUNA_HOST ?? raw?.server?.host } }, process.cwd(), {}).server.host; } catch {}
    try { port = parseConfig({ server: { port: process.env.LUNA_PORT ? Number(process.env.LUNA_PORT) : raw?.server?.port } }, process.cwd(), {}).server.port; } catch {}
    try { publicUrls = parseConfig({ server: { publicUrls: raw?.server?.publicUrls } }, process.cwd(), {}).server.publicUrls; } catch {}
    // Recovery never weakens the normal non-loopback authentication boundary.
    if (bindRefusal(host, token)) host = "127.0.0.1";
    const app = new Hono();
    const origins = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", ...publicUrls.map(u => new URL(u).origin)];
    app.use("*", async (c, next) => { c.header("cache-control", "no-store"); await next(); });
    app.use("/health", cors({ origin: origin => origins.includes(origin) ? origin : undefined }));
    app.use("/v1/*", cors({ origin: origin => origins.includes(origin) ? origin : undefined, allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "OPTIONS"] }));
    app.get("/health", c => c.json({ ok: true, ready: false, auth: !!token }));
    app.use("/v1/*", async (c, next) => {
      if (token) {
        const supplied = Buffer.from(c.req.header("authorization") ?? "");
        const expected = Buffer.from("Bearer " + token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return c.json({ error: "unauthorized" }, 401);
      }
      await next();
    });
    app.get("/v1/config/status", c => c.json({ error: message, path, recovery: true }));
    app.all("/v1/*", c => c.json({ error: "Luna configuration is invalid. Fix the config file to resume.", recovery: true }, 503));
    app.get("/", c => c.html(RECOVERY_PAGE, 200, { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'", "x-content-type-options": "nosniff" }));
    const server = Bun.serve({ hostname: host, port, fetch: app.fetch });
    console.error(`Luna config recovery listening on http://${server.hostname}:${server.port}: ${message}`);
    return await new Promise<LunaConfig>(resolveConfig => {
      const stop = () => { clearInterval(timer); void server.stop(true); process.exit(0); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      const timer = setInterval(() => {
        let cfg: LunaConfig;
        try { cfg = loadConfig(); } catch (e) { message = configDiagnostic(e); return; }
        const refusal = bindRefusal(cfg.server.host, token);
        if (refusal) { message = refusal; return; }
        clearInterval(timer);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        void server.stop(true).then(() => resolveConfig(cfg));
      }, 2000);
    });
  }
}

const RECOVERY_PAGE = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Luna — Configuration error</title>
<style>
:root{color-scheme:light dark;font:16px system-ui;background:#121212;color:#eee}
body{margin:0;padding:24px}main{max-width:48rem;margin:10vh auto;border:1px solid #666;border-radius:2px;padding:24px}
h1{font-size:1.4rem}p{line-height:1.5}pre{white-space:pre-wrap;overflow-wrap:anywhere}
input,button{font:inherit;min-height:44px;box-sizing:border-box;border:1px solid #888;border-radius:2px;background:#222;color:#eee;padding:8px}
input{width:100%;margin:8px 0}button{cursor:pointer} :focus-visible{outline:2px solid #eee;outline-offset:3px}
@media(prefers-color-scheme:light){:root{background:#fff;color:#222}input,button{background:#fff;color:#222}}
</style>
<main><h1>Luna configuration error</h1>
<p>The server is running, but the agent has not started. Fix the config file; Luna checks again automatically.</p>
<label for="token">API token (if required)</label><input id="token" type="password" autocomplete="off">
<button id="check" type="button">Show error</button><pre id="error" role="alert"></pre></main>
<script>
const field=document.getElementById('token'), output=document.getElementById('error');
try{field.value=localStorage.getItem('luna.token')||''}catch{}
async function check(){
  try{
    const r=await fetch('/v1/config/status',{headers:field.value?{authorization:'Bearer '+field.value}:{},cache:'no-store',signal:AbortSignal.timeout(5000)});
    if(r.status===401){output.textContent='Enter your API token to view the error.';return}
    if(!r.ok)throw new Error('Cannot read configuration status.');
    const s=await r.json();
    if(!s.recovery){location.reload();return}
    output.textContent=s.path+'\\n\\n'+s.error;
  }catch(e){output.textContent=e.message}
}
document.getElementById('check').onclick=check;
check();setInterval(check,3000);
</script></html>`;
