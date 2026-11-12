// Opening Settings must never show an error because a config key, catalog entry, or field shape changed.
// Contracts:
// - The real SettingsPage.vue loads GET /v1/settings from the real daemon app (createApp + SettingsStore)
//   and every tab renders with no load error, Vue render error, Vue warning, or uncaught page error.
// - This holds for the default config and for luna.config.example.json (saved providers, MCP servers, profiles).
// Regressions: #320 (a new top-level key without a catalog entry failed the whole page load) and a field shape
// ComponentField cannot render (e.g. a string|object union crashed the tab).
// The page runs in support/settings-page-check.ts, in its own process (see the note there).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, expect } from "bun:test";

const check = new URL("./support/settings-page-check.ts", import.meta.url).pathname;
const example = new URL("../../luna.config.example.json", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "luna-settings-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const empty = join(dir, "empty.json");
writeFileSync(empty, "{}");

for (const [name, config] of [["default config", empty], ["luna.config.example.json", example]] as const) {
  test(`Settings opens and every tab renders for the ${name}`, async () => {
    const proc = Bun.spawn([process.execPath, check, config], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(code).toBe(0) /* `Settings page failed to open:\n${out}${err}` */;
  }, 60_000);
}
