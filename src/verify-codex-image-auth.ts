// Offline authentication contracts. This never reads the user's credentials or contacts OpenAI.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexImageAuth, refreshCodexImageAuth } from "./codex-image-auth.js";
import { parseConfig } from "./config.js";

const dir = mkdtempSync(join(tmpdir(), "luna-codex-image-auth-"));
function credential(exp = Date.now() + 3_600_000, account = "fixture-account") {
  const access_token = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000), "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_data_residency: "us" } })).toString("base64url")}.fixture`;
  return { auth_mode: "chatgpt", tokens: { access_token, refresh_token: "fixture-refresh", account_id: account } };
}
const save = (data: object) => writeFileSync(join(dir, "auth.json"), JSON.stringify(data), { mode: 0o600 });
const signal = new AbortController().signal;
try {
  let refreshes = 0;
  const auth = createCodexImageAuth({ config: () => ({ codexHome: dir }), refresh: async () => { refreshes++; save(credential()); } });
  assert.equal(auth.is_available(), false);
  await assert.rejects(auth.resolve(signal), (e: any) => e.error_type === "auth_required");
  for (const file of [{ auth_mode: "apikey", OPENAI_API_KEY: "fixture-api-key" }, { ...credential(), auth_mode: "apikey" }, { auth_mode: "chatgpt", tokens: { access_token: "broken" } }, { ...credential(), tokens: { ...credential().tokens, account_id: "other-account" } }]) {
    save(file); assert.equal(auth.is_available(), false);
  }
  save(credential()); assert.equal(auth.is_available(), true);
  const result = await auth.resolve(signal); assert.equal(result.accountId, "fixture-account"); assert.equal(result.residency, "us"); assert.equal(refreshes, 0);
  save(credential(Date.now() - 1000));
  await Promise.all([auth.resolve(signal), auth.resolve(signal)]); assert.equal(refreshes, 1, "concurrent calls share one refresh");
  save(credential(Date.now() - 1000));
  const changed = createCodexImageAuth({ config: () => ({ codexHome: dir }), refresh: async () => save(credential(Date.now() + 3_600_000, "other-account")) });
  await assert.rejects(changed.resolve(signal), (e: any) => e.error_type === "auth_changed");
  save(credential(Date.now() - 1000));
  const failed = createCodexImageAuth({ config: () => ({ codexHome: dir }), refresh: async () => { throw new Error("secret refresh data"); } });
  await assert.rejects(failed.resolve(signal), (e: any) => e.error_type === "auth_refresh_failed" && !e.message.includes("secret refresh data"));
  const stale = createCodexImageAuth({ config: () => ({ codexHome: dir }), refresh: async () => {} });
  await assert.rejects(stale.resolve(signal), (e: any) => e.error_type === "auth_refresh_failed");

  // Cancellation must not discard a rotated refresh token. The official CLI completes persistence.
  save(credential(Date.now() - 1000));
  let release!: () => void, completed = false;
  const slow = createCodexImageAuth({ config: () => ({ codexHome: dir }), refresh: async (_home, _command, refreshSignal) => {
    await new Promise<void>(resolve => { release = resolve; }); assert.equal(refreshSignal.aborted, false); save(credential()); completed = true;
  } });
  const abort = new AbortController(), pending = slow.resolve(abort.signal);
  await new Promise(resolve => setTimeout(resolve, 0)); abort.abort(); await assert.rejects(pending); assert.equal(completed, false);
  release(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(completed, true);

  // Exercise the real stdio client against a fake Codex binary; no model request can pass.
  const command = join(dir, "codex-fixture");
  writeFileSync(command, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["app-server", "--listen", "stdio://"])) process.exit(2);
readline.createInterface({input:process.stdin}).on("line", line => {
 const msg = JSON.parse(line);
 if(msg.method === "initialize") console.log(JSON.stringify({id:msg.id,result:{}}));
 else if(msg.method === "initialized") {}
 else if(msg.method === "account/read" && msg.params.refreshToken === true) {
  fs.writeFileSync(process.env.CODEX_HOME + "/refreshed", "yes");
  console.log(JSON.stringify({id:msg.id,result:{account:{type:"chatgpt"}}}));
 } else process.exit(3);
});
`, { mode: 0o700 });
  await refreshCodexImageAuth(dir, command, AbortSignal.timeout(10_000));
  assert.equal(readFileSync(join(dir, "refreshed"), "utf8"), "yes");
  await assert.rejects(refreshCodexImageAuth(dir, join(dir, "missing"), AbortSignal.timeout(1000)));
  const hanging = join(dir, "codex-hanging");
  writeFileSync(hanging, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o700 });
  const started = Date.now(); await assert.rejects(refreshCodexImageAuth(dir, hanging, AbortSignal.timeout(150))); assert.ok(Date.now() - started < 3000);
  const cfg = parseConfig({ image_gen: { "openai-codex": { codexHome: "fixture" } } }, dir, {});
  assert.equal(cfg.image_gen["openai-codex"].codexHome, join(dir, "fixture"));
  assert.equal(cfg.image_gen["openai-codex"].quality, "low");
  console.log("CODEX_IMAGE_AUTH_OK: subscription-only, no API keys, identity, expiry, shared refresh, cancellation, official CLI RPC and cleanup");
} finally { rmSync(dir, { recursive: true, force: true }); }
