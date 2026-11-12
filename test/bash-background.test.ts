// Contract: bash background:true starts a managed process; process_manage lists, reads, waits for, and stops it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { BusyExecutions } from "../src/busy-tools.js";

type Tool = { name: string; parameters: unknown; prepareArguments?: (a: unknown) => unknown; execute(args: Record<string, unknown>, api: unknown, ctx: unknown): Promise<any> };

const setup = (enabled: boolean) => {
  const dir = mkdtempSync(join(tmpdir(), "luna-bash-bg-"));
  const busy = new BusyExecutions(async () => {}, { enabled });
  const coding = busy.codingTools(CodingTools).tools as unknown as Tool[];
  const manage = (busy.extension().tools as unknown as Tool[])[0]!;
  let out = "";
  // The harness supplies the output API to foreground bash; a minimal one keeps this a unit test.
  const api = { conversationId: 5, env: busy.env(5 as never, dir, "owner-a"), output: (t: string) => { out += t; }, retainedOutput: () => ({ text: out, truncated: false }), diagnostic: () => {} };
  const bash = coding.find(t => t.name === "bash")!;
  const ctx = {};
  return {
    dir, busy, coding, manage,
    bash: (args: Record<string, unknown>) => bash.execute(args, api, ctx),
    pm: (args: Record<string, unknown>) => manage.execute((manage.prepareArguments?.(args) ?? args) as Record<string, unknown>, api, ctx),
  };
};

test("coding tools keep read/write/edit and bash gains a background flag", () => {
  const { dir, coding, manage } = setup(true);
  try {
    expect(coding.map(t => t.name).sort()).toEqual(["bash", "edit", "read", "write"]);
    expect(manage.name).toBe("process_manage");
    expect(JSON.stringify(coding.find(t => t.name === "bash")!.parameters).includes("background")).toBeTruthy();
    expect(() => manage.prepareArguments!({ action: "start", command: "true" })).toThrow(/no start action. Run bash with background: true/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bash background starts a process that process_manage waits for and reads", async () => {
  const { dir, busy, bash, pm } = setup(true);
  try {
    const started = await bash({ command: "echo BG_SENTINEL", background: true });
    const id = started.structuredOutput.id as string;
    expect(started.structuredOutput.output).toMatch(/Process ID/);
    expect(started.output[0].text).toMatch(new RegExp(`Process ID: ${id}`));
    expect((await pm({ action: "list" })).output[0].text.includes(id)).toBe(true);
    const done = JSON.parse((await pm({ action: "wait", id, timeoutSec: 10 })).output[0].text);
    expect(done.status).toBe("complete"); expect(done.output).toMatch(/BG_SENTINEL/);
    await busy.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bash background is refused when background processes are off; foreground bash still runs", async () => {
  const { dir, busy, bash } = setup(false);
  try {
    await expect(bash({ command: "true", background: true })).rejects.toThrow(/Background commands are disabled/);
    const fg = await bash({ command: "echo FG" });
    expect(fg.structuredOutput.exitCode).toBe(0); expect(fg.structuredOutput.output).toMatch(/FG/);
    await busy.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
