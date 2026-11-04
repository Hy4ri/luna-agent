// Contract: config is validated strictly. Unknown or conflicting settings fail at load time instead of being ignored,
// the documented example always loads, and a non-loopback bind needs LUNA_TOKEN.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bindRefusal, parseConfig } from "../src/config.js";
import { SettingsStore } from "../src/settings.js";

const base = "/srv/luna";
const parse = (raw: unknown, env: NodeJS.ProcessEnv = {}) => parseConfig(raw, base, env);
const rejects = (raw: unknown, pattern: RegExp) => assert.throws(() => parse(raw), pattern, JSON.stringify(raw));
const stdio = (name: string) => ({ name, transport: "stdio", command: "x" });
const provider = (id: string) => ({ id, name: id, api: "openai-completions", baseUrl: "https://example.com/v1", models: [{ id: "m" }] });

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
  rejects({ provider: "faux", subagents: { profiles: { r: { tools: ["delegate_task"] } } } }, /Child profiles cannot delegate/);
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

test("live settings: external edits, saves, and invalid files apply on the next read; callers get private copies", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-settings-"));
  try {
    const path = join(dir, "luna.config.json");
    writeFileSync(path, JSON.stringify({ dataDir: dir, provider: "faux", model: "faux", busyInput: { mode: "queue" } }));
    const settings = new SettingsStore(path, dir);
    const copy = settings.resolved();
    copy.busyInput.mode = "steer";
    assert.equal(settings.resolved().busyInput.mode, "queue");
    settings.update(c => { c.busyInput.mode = "interrupt"; });
    assert.equal(settings.resolved().busyInput.mode, "interrupt");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.busyInput.mode = "steer";
    writeFileSync(path, JSON.stringify(raw)); // in place: same inode
    assert.equal(settings.resolved().busyInput.mode, "steer");
    assert.equal(settings.resolved({ ...process.env, LUNA_MODEL: "other" }).model, "other");
    assert.equal(settings.resolved().model, "faux");
    writeFileSync(path, "{");
    assert.throws(() => settings.resolved());
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
});
