// Contract: config is validated strictly. Unknown or conflicting settings fail at load time instead of being ignored,
// the documented example always loads, and a non-loopback bind needs LUNA_TOKEN.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { bindRefusal, ConfigSchema, parseConfig } from "../src/config.js";
import { nativeCompaction } from "../src/compaction-limits.js";
import { SettingsStore } from "../src/settings.js";

const base = "/srv/luna";
const parse = (raw: unknown, env: NodeJS.ProcessEnv = {}) => parseConfig(raw, base, env);
const rejects = (raw: unknown, pattern: RegExp) => assert.throws(() => parse(raw), pattern, JSON.stringify(raw));
const stdio = (name: string) => ({ name, transport: "stdio", command: "x" });
const provider = (id: string) => ({ id, name: id, api: "openai-completions", baseUrl: "https://example.com/v1", models: [{ id: "m" }] });

test("config discovery uses home .luna, ignores checkout config, and honors explicit overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-config-discovery-"));
  try {
    const home = join(dir, "home"), cwd = join(dir, "checkout");
    mkdirSync(join(home, ".luna"), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(home, ".luna", "luna.config.json"), JSON.stringify({ model: "home", dataDir: "state" }));
    writeFileSync(join(cwd, "luna.config.json"), JSON.stringify({ model: "checkout" }));
    writeFileSync(join(cwd, "override.json"), JSON.stringify({ model: "override" }));
    // A separate process isolates HOME, cwd, and config overrides from the rest of the suite.
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import assert from "node:assert/strict";
      import { unlinkSync } from "node:fs";
      import { join } from "node:path";
      import { loadConfig } from ${JSON.stringify(new URL("../src/config.js", import.meta.url).href)};
      delete process.env.LUNA_CONFIG;
      delete process.env.LUNA_DATA;
      delete process.env.LUNA_MODEL;
      const expected = join(process.env.HOME, ".luna", "luna.config.json");
      const config = loadConfig();
      assert.equal(config.configPath, expected);
      assert.equal(config.model, "home");
      assert.equal(config.dataDir, join(process.env.HOME, ".luna", "state"));
      process.env.LUNA_CONFIG = "override.json";
      assert.equal(loadConfig().model, "override");
      assert.equal(loadConfig(expected).model, "home", "argument overrides environment");
      process.env.LUNA_CONFIG = "missing.json";
      assert.throws(() => loadConfig(), /config not found/);
      delete process.env.LUNA_CONFIG;
      unlinkSync(expected);
      assert.equal(loadConfig().configPath, expected);
      assert.notEqual(loadConfig().model, "checkout", "no fallback to checkout config");
    `], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 10_000 });
    assert.equal(result.exitCode, 0, result.stderr.toString() || "config discovery subprocess failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("startup config recovery serves authenticated diagnostics and resumes after repair without exiting", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-config-recovery-"));
  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import assert from "node:assert/strict";
      import { writeFileSync, readdirSync } from "node:fs";
      import { loadDaemonConfig } from ${JSON.stringify(new URL("../src/config-recovery.js", import.meta.url).href)};
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = probe.port;
      await probe.stop(true);
      process.env.LUNA_CONFIG = ${JSON.stringify(join(dir, "luna.config.json"))};
      process.env.LUNA_HOST = "127.0.0.1";
      process.env.LUNA_PORT = String(port);
      writeFileSync(process.env.LUNA_CONFIG, '{"secret":"never-show-this",');
      const pending = loadDaemonConfig("test-token");
      const base = "http://127.0.0.1:" + port;
      const health = await fetch(base + "/health");
      assert.deepEqual(await health.json(), { ok: true, ready: false, auth: true });
      assert.equal((await fetch(base + "/v1/config/status")).status, 401);
      const headers = { authorization: "Bearer test-token", origin: "tauri://localhost" };
      const response = await fetch(base + "/v1/config/status", { headers });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("access-control-allow-origin"), "tauri://localhost");
      const status = await response.json();
      assert.equal(status.recovery, true);
      assert.match(status.error, /Invalid JSON/);
      assert.ok(!status.error.includes("never-show-this"));
      assert.equal((await fetch(base + "/v1/sessions", { headers })).status, 503);
      assert.match(await (await fetch(base)).text(), /Luna configuration error/);
      assert.deepEqual(readdirSync(${JSON.stringify(dir)}).filter(name => name !== ".bun"), ["luna.config.json"], "no agent stores during recovery; Bun may create its own cache");
      writeFileSync(process.env.LUNA_CONFIG, JSON.stringify({ provider: "faux", model: "repaired" }));
      assert.equal((await pending).model, "repaired");
    `], { env: { PATH: process.env.PATH, HOME: dir, LUNA_DATA: dir }, timeout: 10_000 });
    assert.equal(result.exitCode, 0, result.stderr.toString() || "config recovery subprocess failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("luna.config.example.json loads", () => {
  const raw = JSON.parse(readFileSync(new URL("../luna.config.example.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => parse(raw));
});

test("unknown keys fail at the root and in nested objects", () => {
  rejects({ provider: "faux", typo: 1 }, /\(root\)|typo/);
  rejects({ provider: "faux", server: { host: "127.0.0.1", prot: 1 } }, /server/);
  rejects({ provider: "faux", mcpServers: [{ ...stdio("a"), envv: {} }] }, /mcpServers/);
  rejects({ provider: "faux", providers: [{ ...provider("p"), models: [{ id: "m", ctx: 1 }] }] }, /providers/);
});

test("unknown extensions and duplicate names fail", () => {
  rejects({ provider: "faux", extensions: ["coding", "nope"] }, /extensions/);
  rejects({ provider: "faux", extensions: ["coding", "coding"] }, /duplicate extension/);
  rejects({ provider: "faux", providers: [provider("p"), provider("p")] }, /duplicate provider id/);
  rejects({ provider: "faux", providers: [provider("openai")] }, /conflicts with a built-in provider/);
  rejects({ provider: "faux", mcpServers: [stdio("a"), stdio("a")] }, /duplicate MCP server name "a"/);
});

test("cross-field rules fail", () => {
  rejects({ provider: "anthropic" }, /model is required for provider anthropic/);
  rejects({ provider: "faux", subagents: { provider: "anthropic" } }, /provider and model must be set together/);
  rejects({ provider: "faux", subagents: { profiles: { r: { tools: ["subagent"] } } } }, /Child profiles cannot delegate/);
});

test("environment overrides apply before validation and are validated too", () => {
  const c = parse({ provider: "faux" }, { LUNA_HOST: "0.0.0.0", LUNA_PORT: "9000", LUNA_DATA: "state" });
  assert.equal(c.server.host, "0.0.0.0");
  assert.equal(c.server.port, 9000);
  assert.equal(c.dataDir, join(base, "state"), "relative dataDir resolves against the config directory");
  assert.throws(() => parse({ provider: "faux" }, { LUNA_PORT: "0" }), /server\.port/);
});

test("skill directories: dataDir/skills first, then configured directories", () => {
  const c = parse({ provider: "faux", dataDir: "/d", skillDirs: ["extra"] });
  assert.deepEqual(c.allSkillDirs, ["/d/skills", join(base, "extra")]);
});

test("a non-loopback bind is refused without LUNA_TOKEN", () => {
  for (const host of ["127.0.0.1", "localhost", "::1"]) assert.equal(bindRefusal(host, undefined), undefined, host);
  for (const host of ["0.0.0.0", "::", "192.168.1.20", "luna.lan"]) assert.match(bindRefusal(host, undefined) ?? "", /LUNA_TOKEN/, host);
  assert.equal(bindRefusal("0.0.0.0", ""), bindRefusal("0.0.0.0", undefined), "an empty token is no token");
  assert.equal(bindRefusal("0.0.0.0", "t"), undefined);
});

test("live settings retain valid policy during invalid edits and recover without overwriting disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-settings-"));
  try {
    const path = join(dir, "luna.config.json");
    writeFileSync(path, JSON.stringify({ dataDir: dir, provider: "faux", model: "faux", busyInput: { mode: "queue" } }));
    const settings = new SettingsStore(path, dir);
    const copy = settings.resolved();
    copy.busyInput.mode = "steer";
    assert.equal(settings.resolved().busyInput.mode, "queue");
    settings.update(c => { c.busyInput.mode = "steer"; });
    assert.equal(settings.resolved().busyInput.mode, "steer");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.busyInput.mode = "queue";
    writeFileSync(path, JSON.stringify(raw)); // in place: same inode
    assert.equal(settings.resolved().busyInput.mode, "queue");
    // The retired redirect mode loads as steer instead of failing strict validation.
    raw.busyInput.mode = "interrupt";
    writeFileSync(path, JSON.stringify(raw));
    assert.equal(settings.resolved().busyInput.mode, "steer");
    raw.busyInput.mode = "queue";
    writeFileSync(path, JSON.stringify(raw));
    assert.equal(settings.resolved({ ...process.env, LUNA_MODEL: "other" }).model, "other");
    assert.equal(settings.resolved().model, "faux");
    for (const invalid of ["{", JSON.stringify({ busyInput: { mode: "typo" } })]) {
      writeFileSync(path, invalid);
      assert.equal(settings.resolved().busyInput.mode, "queue");
      assert.equal(settings.read().busyInput.mode, "queue");
      assert.ok(settings.configError);
      assert.throws(() => settings.update(c => { c.model = "changed"; }));
      assert.equal(readFileSync(path, "utf8"), invalid);
    }
    rmSync(path);
    assert.equal(settings.resolved().busyInput.mode, "queue");
    assert.ok(settings.configError);
    assert.throws(() => settings.update(c => { c.model = "changed"; }));
    writeFileSync(path, JSON.stringify({ provider: "faux", busyInput: { mode: "steer" } }));
    assert.equal(settings.resolved().busyInput.mode, "steer");
    assert.equal(settings.configError, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("maxTurns is a positive integer at the root, in subagent defaults, and in a profile", () => {
  const profile = { tools: ["read"], maxTurns: 5 };
  const c = parse({ provider: "faux", maxTurns: 60, subagents: { maxTurns: 40, profiles: { r: profile } } });
  assert.equal(c.maxTurns, 60);
  assert.equal(c.subagents.maxTurns, 40);
  assert.equal(c.subagents.profiles.r?.maxTurns, 5);
  assert.equal(parse({ provider: "faux" }).maxTurns, undefined, "no limit by default");
  for (const bad of [0, -1, 1.5, "3"]) rejects({ provider: "faux", maxTurns: bad }, /maxTurns/);
  rejects({ provider: "faux", subagents: { profiles: { r: { ...profile, maxTurns: 0 } } } }, /maxTurns/);
});

test("Code Mode rejects unknown settings and deadlines outside the supported timer range", () => {
  rejects({ codemode: { typo: 1 } }, /codemode/);
  for (const timeoutMs of [0, -1, 1.5, 2_147_483_648]) rejects({ codemode: { timeoutMs } }, /codemode/);
  for (const memoryLimitBytes of [0, -1, 1.5]) rejects({ codemode: { memoryLimitBytes } }, /codemode/);
});

test("compaction defaults, partial overrides, and threshold ordering", () => {
  const config = parse({});
  assert.deepEqual(config.compaction, {
    sessions: { backgroundAtTokens: 120000, blockAtTokens: 160000, keepRecentTokens: 20000 },
    subagents: { backgroundAtTokens: 80000, blockAtTokens: 120000, keepRecentTokens: 20000 },
  });
  assert.equal(parse({ compaction: { subagents: { blockAtTokens: 100000 } } }).compaction.subagents.blockAtTokens, 100000);
  for (const value of [0, -1, 1.5]) rejects({ compaction: { sessions: { backgroundAtTokens: value } } }, /compaction/);
  rejects({ compaction: { sessions: { backgroundAtTokens: 160000 } } }, /backgroundAtTokens/);
  rejects({ compaction: { subagents: { keepRecentTokens: 80000 } } }, /keepRecentTokens/);
  rejects({ compaction: { sessions: { typo: 1 } } }, /compaction/);
  assert.deepEqual(
    nativeCompaction(config.compaction.sessions, [
      { provider: "p", id: "big", contextWindow: 1_000_000 },
      { provider: "p", id: "small", contextWindow: 128_000 },
      { provider: "p", id: "unknown" },
    ]),
    {
      keepRecentTokens: 20000,
      modelOverrides: {
        "p/big": { reserveTokens: 840000, backgroundTokens: 40000, keepRecentTokens: 20000 },
        "p/small": { reserveTokens: 16384, backgroundTokens: 32768, keepRecentTokens: 20000 },
      },
    },
  );
});

test("terminal access is off by default and rejects unknown fields", () => {
  assert.equal(parse({}).terminal.user, false);
  assert.equal(parse({ terminal: { user: true } }).terminal.user, true);
  assert.equal(parse({}).terminal.agent, false);
  assert.equal(parse({ terminal: { agent: true } }).terminal.agent, true);
  rejects({ terminal: { other: true } }, /terminal/);
  rejects({ terminal: { user: "yes" } }, /terminal/);
});

test("browser.providers.chromium.cdpUrl takes an HTTP or WebSocket URL only", () => {
  const parse = (cdpUrl: string) => ConfigSchema.safeParse({ browser: { providers: { chromium: { cdpUrl } } } }).success;
  assert.equal(parse("http://127.0.0.1:9222"), true);
  assert.equal(parse("ws://127.0.0.1:9222/devtools/browser/x"), true);
  assert.equal(parse("file:///tmp/x"), false);
  assert.equal(parse("9222"), false);
});

test("retired recovery budget loads but never reappears in settings, disk saves, or the form schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-recovery-settings-"));
  try {
    const path = join(dir, "luna.config.json");
    writeFileSync(path, JSON.stringify({ dataDir: dir, provider: "faux", model: "faux", autoContinue: { enabled: true, maxAttempts: 5 } }));
    const settings = new SettingsStore(path, dir);
    assert.deepEqual(settings.read().autoContinue, { enabled: true, maxWaitHours: 168, resetGraceSeconds: 60 });
    const schema = ConfigSchema.toJSONSchema() as any;
    assert.equal(schema.properties.autoContinue.properties.maxAttempts, undefined);
    settings.update(s => { s.autoContinue.resetGraceSeconds = 90; });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).autoContinue.maxAttempts, undefined);
    assert.equal(settings.resolved().autoContinue.resetGraceSeconds, 90);
    for (const resetGraceSeconds of [-1, 3601, 0.5, "60"]) rejects({ autoContinue: { resetGraceSeconds } }, /resetGraceSeconds/);
    rejects({ autoContinue: { maxAttempts: 5, typo: true } }, /autoContinue/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("configs saved before Wife still load: removed learn/improve keys are dropped", () => {
  const c = parseConfig({ extensions: ["coding", "improve", "learn", "skills"], learn: { idleMinutes: 5, files: [] }, improve: { schedule: "0 4 * * *", allowCommandBenchmarks: true } });
  assert.deepEqual(c.extensions, ["coding", "skills"]);
  assert.equal("learn" in c, false);
  assert.deepEqual(c.improve, { allowCommandBenchmarks: true });
});
