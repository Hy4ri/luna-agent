// Contract: config is validated strictly. Unknown or conflicting settings fail at load time instead of being ignored,
// the documented example always loads, and a non-loopback bind needs LUNA_TOKEN.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { bindRefusal, ConfigSchema, parseConfig } from "../src/config.js";
import { nativeCompaction } from "../src/compaction-limits.js";
import { SettingsStore } from "../src/settings.js";
import { throwsWith } from "./support/expect-error.js";

const base = "/srv/luna";
const parse = (raw: unknown, env: NodeJS.ProcessEnv = {}) => parseConfig(raw, base, env);
const rejects = (raw: unknown, pattern: RegExp) => throwsWith(() => parse(raw), pattern, JSON.stringify(raw));
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
      import { expect } from "bun:test";
      import { unlinkSync } from "node:fs";
      import { join } from "node:path";
      import { loadConfig } from ${JSON.stringify(new URL("../src/config.js", import.meta.url).href)};
      delete process.env.LUNA_CONFIG;
      delete process.env.LUNA_DATA;
      delete process.env.LUNA_MODEL;
      const expected = join(process.env.HOME, ".luna", "luna.config.json");
      const config = loadConfig();
      expect(config.configPath).toBe(expected);
      expect(config.model).toBe("home");
      expect(config.dataDir).toBe(join(process.env.HOME, ".luna", "state"));
      process.env.LUNA_CONFIG = "override.json";
      expect(loadConfig().model).toBe("override");
      expect(loadConfig(expected).model, "argument overrides environment").toBe("home");
      process.env.LUNA_CONFIG = "missing.json";
      expect(() => loadConfig()).toThrow(/config not found/);
      delete process.env.LUNA_CONFIG;
      unlinkSync(expected);
      expect(loadConfig().configPath).toBe(expected);
      expect(loadConfig().model, "no fallback to checkout config").not.toBe("checkout");
    `], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 10_000 });
    expect(result.exitCode, result.stderr.toString() || "config discovery subprocess failed").toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("startup config recovery serves authenticated diagnostics and resumes after repair without exiting", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-config-recovery-"));
  try {
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { expect } from "bun:test";
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
      expect(await health.json()).toStrictEqual({ ok: true, ready: false, auth: true });
      expect((await fetch(base + "/v1/config/status")).status).toBe(401);
      const headers = { authorization: "Bearer test-token", origin: "tauri://localhost" };
      const response = await fetch(base + "/v1/config/status", { headers });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
      const status = await response.json();
      expect(status.recovery).toBe(true);
      expect(status.error).toMatch(/Invalid JSON/);
      expect(!status.error.includes("never-show-this")).toBeTruthy();
      expect((await fetch(base + "/v1/sessions", { headers })).status).toBe(503);
      expect(await (await fetch(base)).text()).toMatch(/Luna configuration error/);
      expect(readdirSync(${JSON.stringify(dir)}).filter(name => name !== ".bun"), "no agent stores during recovery; Bun may create its own cache").toStrictEqual(["luna.config.json"]);
      writeFileSync(process.env.LUNA_CONFIG, JSON.stringify({ provider: "faux", model: "repaired" }));
      expect((await pending).model).toBe("repaired");
    `], { env: { PATH: process.env.PATH, HOME: dir, LUNA_DATA: dir }, timeout: 10_000 });
    expect(result.exitCode, result.stderr.toString() || "config recovery subprocess failed").toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("luna.config.example.json loads", () => {
  const raw = JSON.parse(readFileSync(new URL("../luna.config.example.json", import.meta.url), "utf8"));
  expect(() => parse(raw)).not.toThrow();
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
  expect(c.server.host).toBe("0.0.0.0");
  expect(c.server.port).toBe(9000);
  expect(c.dataDir, "relative dataDir resolves against the config directory").toBe(join(base, "state"));
  throwsWith(() => parse({ provider: "faux" }, { LUNA_PORT: "0" }), /server\.port/);
});

test("skill directories: dataDir/skills first, then configured directories", () => {
  const c = parse({ provider: "faux", dataDir: "/d", skillDirs: ["extra"] });
  expect(c.allSkillDirs).toStrictEqual(["/d/skills", join(base, "extra")]);
});

test("a non-loopback bind is refused without LUNA_TOKEN", () => {
  for (const host of ["127.0.0.1", "localhost", "::1"]) expect(bindRefusal(host, undefined), host).toBe(undefined);
  for (const host of ["0.0.0.0", "::", "192.168.1.20", "luna.lan"]) expect(bindRefusal(host, undefined) ?? "", host).toMatch(/LUNA_TOKEN/);
  expect(bindRefusal("0.0.0.0", ""), "an empty token is no token").toBe(bindRefusal("0.0.0.0", undefined));
  expect(bindRefusal("0.0.0.0", "t")).toBe(undefined);
});

test("live settings retain valid policy during invalid edits and recover without overwriting disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-settings-"));
  try {
    const path = join(dir, "luna.config.json");
    writeFileSync(path, JSON.stringify({ dataDir: dir, provider: "faux", model: "faux", busyInput: { mode: "queue" } }));
    const settings = new SettingsStore(path, dir);
    const copy = settings.resolved();
    copy.busyInput.mode = "steer";
    expect(settings.resolved().busyInput.mode).toBe("queue");
    settings.update(c => { c.busyInput.mode = "steer"; });
    expect(settings.resolved().busyInput.mode).toBe("steer");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.busyInput.mode = "queue";
    writeFileSync(path, JSON.stringify(raw)); // in place: same inode
    expect(settings.resolved().busyInput.mode).toBe("queue");
    // The retired redirect mode loads as steer instead of failing strict validation.
    raw.busyInput.mode = "interrupt";
    writeFileSync(path, JSON.stringify(raw));
    expect(settings.resolved().busyInput.mode).toBe("steer");
    raw.busyInput.mode = "queue";
    writeFileSync(path, JSON.stringify(raw));
    expect(settings.resolved({ ...process.env, LUNA_MODEL: "other" }).model).toBe("other");
    expect(settings.resolved().model).toBe("faux");
    for (const invalid of ["{", JSON.stringify({ busyInput: { mode: "typo" } })]) {
      writeFileSync(path, invalid);
      expect(settings.resolved().busyInput.mode).toBe("queue");
      expect(settings.read().busyInput.mode).toBe("queue");
      expect(settings.configError).toBeTruthy();
      throwsWith(() => settings.update(c => { c.model = "changed"; }));
      expect(readFileSync(path, "utf8")).toBe(invalid);
    }
    rmSync(path);
    expect(settings.resolved().busyInput.mode).toBe("queue");
    expect(settings.configError).toBeTruthy();
    throwsWith(() => settings.update(c => { c.model = "changed"; }));
    writeFileSync(path, JSON.stringify({ provider: "faux", busyInput: { mode: "steer" } }));
    expect(settings.resolved().busyInput.mode).toBe("steer");
    expect(settings.configError).toBe(undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("maxTurns is a positive integer at the root, in subagent defaults, and in a profile", () => {
  const profile = { tools: ["read"], maxTurns: 5 };
  const c = parse({ provider: "faux", maxTurns: 60, subagents: { maxTurns: 40, profiles: { r: profile } } });
  expect(c.maxTurns).toBe(60);
  expect(c.subagents.maxTurns).toBe(40);
  expect(c.subagents.profiles.r?.maxTurns).toBe(5);
  expect(parse({ provider: "faux" }).maxTurns, "no limit by default").toBe(undefined);
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
  expect(config.compaction).toStrictEqual({
    sessions: { backgroundAtTokens: 120000, blockAtTokens: 160000, keepRecentTokens: 20000 },
    subagents: { backgroundAtTokens: 80000, blockAtTokens: 120000, keepRecentTokens: 20000 },
  });
  expect(parse({ compaction: { subagents: { blockAtTokens: 100000 } } }).compaction.subagents.blockAtTokens).toBe(100000);
  for (const value of [0, -1, 1.5]) rejects({ compaction: { sessions: { backgroundAtTokens: value } } }, /compaction/);
  rejects({ compaction: { sessions: { backgroundAtTokens: 160000 } } }, /backgroundAtTokens/);
  rejects({ compaction: { subagents: { keepRecentTokens: 80000 } } }, /keepRecentTokens/);
  rejects({ compaction: { sessions: { typo: 1 } } }, /compaction/);
  expect(nativeCompaction(config.compaction.sessions, [
      { provider: "p", id: "big", contextWindow: 1_000_000 },
      { provider: "p", id: "small", contextWindow: 128_000 },
      { provider: "p", id: "unknown" },
    ])).toStrictEqual({
      keepRecentTokens: 20000,
      modelOverrides: {
        "p/big": { reserveTokens: 840000, backgroundTokens: 40000, keepRecentTokens: 20000 },
        "p/small": { reserveTokens: 16384, backgroundTokens: 32768, keepRecentTokens: 20000 },
      },
    });
});

test("terminal access is off by default and rejects unknown fields", () => {
  expect(parse({}).terminal.user).toBe(false);
  expect(parse({ terminal: { user: true } }).terminal.user).toBe(true);
  expect(parse({}).terminal.agent).toBe(false);
  expect(parse({ terminal: { agent: true } }).terminal.agent).toBe(true);
  rejects({ terminal: { other: true } }, /terminal/);
  rejects({ terminal: { user: "yes" } }, /terminal/);
});

test("browser.providers.chromium.cdpUrl takes an HTTP or WebSocket URL only", () => {
  const parse = (cdpUrl: string) => ConfigSchema.safeParse({ browser: { providers: { chromium: { cdpUrl } } } }).success;
  expect(parse("http://127.0.0.1:9222")).toBe(true);
  expect(parse("ws://127.0.0.1:9222/devtools/browser/x")).toBe(true);
  expect(parse("file:///tmp/x")).toBe(false);
  expect(parse("9222")).toBe(false);
});

test("retired recovery budget loads but never reappears in settings, disk saves, or the form schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-recovery-settings-"));
  try {
    const path = join(dir, "luna.config.json");
    writeFileSync(path, JSON.stringify({ dataDir: dir, provider: "faux", model: "faux", autoContinue: { enabled: true, maxAttempts: 5 } }));
    const settings = new SettingsStore(path, dir);
    expect(settings.read().autoContinue).toStrictEqual({ enabled: true, maxWaitHours: 168, resetGraceSeconds: 60 });
    const schema = ConfigSchema.toJSONSchema() as any;
    expect(schema.properties.autoContinue.properties.maxAttempts).toBe(undefined);
    settings.update(s => { s.autoContinue.resetGraceSeconds = 90; });
    expect(JSON.parse(readFileSync(path, "utf8")).autoContinue.maxAttempts).toBe(undefined);
    expect(settings.resolved().autoContinue.resetGraceSeconds).toBe(90);
    for (const resetGraceSeconds of [-1, 3601, 0.5, "60"]) rejects({ autoContinue: { resetGraceSeconds } }, /resetGraceSeconds/);
    rejects({ autoContinue: { maxAttempts: 5, typo: true } }, /autoContinue/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("configs saved before Steward still load: removed learn/improve keys are dropped", () => {
  const c = parseConfig({ extensions: ["coding", "improve", "learn", "skills"], learn: { idleMinutes: 5, files: [] }, improve: { schedule: "0 4 * * *", allowCommandBenchmarks: true } });
  expect(c.extensions).toStrictEqual(["coding", "skills"]);
  expect("learn" in c).toBe(false);
  expect(c.improve).toStrictEqual({ allowCommandBenchmarks: true });
});

test("deprecated wife config key and extension name migrate to steward", () => {
  const c = parseConfig({ extensions: ["coding", "wife"], disabledTools: ["wife"], wife: { enabled: false, staleDays: 7 } });
  expect(c.extensions).toStrictEqual(["coding", "steward"]);
  expect(c.disabledTools).toStrictEqual(["steward"]);
  expect(c.steward.enabled).toBe(false);
  expect(c.steward.staleDays).toBe(7);
  expect("wife" in c).toBe(false);
});


test("the live settings store loads a pre-Steward config and saves it with the new names", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-wife-settings-"));
  try {
    const path = join(dir, "luna.config.json");
    writeFileSync(path, JSON.stringify({ dataDir: dir, provider: "faux", model: "faux", extensions: ["coding", "wife"], disabledTools: ["wife"], wife: { enabled: false, staleDays: 7 } }));
    const settings = new SettingsStore(path, dir);
    expect(settings.read().extensions).toStrictEqual(["coding", "steward"]);
    expect(settings.read().steward.staleDays).toBe(7);
    expect(settings.resolved().steward.enabled).toBe(false);
    const disk = JSON.parse(readFileSync(path, "utf8"));
    expect("wife" in disk).toBe(false);
    expect(disk.extensions).toStrictEqual(["coding", "steward"]);
    expect(disk.disabledTools).toStrictEqual(["steward"]);
    // An external edit back to the old names still loads instead of breaking live readers.
    writeFileSync(path, JSON.stringify({ ...disk, extensions: ["coding", "wife"], wife: disk.steward, steward: undefined }));
    expect(settings.read().extensions).toStrictEqual(["coding", "steward"]);
    expect(settings.configError).toBe(undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
