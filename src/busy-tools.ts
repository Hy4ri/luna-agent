// A tool can yield its wait without stopping the OS process. Output stays owned by this manager.
import { randomUUID } from "node:crypto";
import { withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { defineExtension, defineTool, type ConversationId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

type Exec = ExecutionEnv["exec"];
type Result = Awaited<ReturnType<Exec>>;
type Process = { id: string; session: ConversationId; output: string; background: boolean; controller: AbortController; result?: Result; done: Promise<Result>; yield: () => void };
export class BusyExecutions {
  private processes = new Map<string, Process>();
  private closing = false;
  constructor(private deliver: (id: ConversationId, message: string, requestId: string) => Promise<void>) {}
  env(session: ConversationId, cwd: string): ExecutionEnv {
    const env = new NodeExecutionEnv({ cwd });
    return new Proxy(env, { get: (target, key) => key === "exec" ? ((command, options, caller) => this.exec(target, session, command, options, caller)) as Exec : typeof Reflect.get(target, key) === "function" ? Reflect.get(target, key).bind(target) : Reflect.get(target, key) });
  }
  private exec(env: ExecutionEnv, session: ConversationId, ...args: Parameters<Exec>): ReturnType<Exec> {
    const [command, options, caller] = args;
    const id = randomUUID(), controller = new AbortController();
    const abort = () => controller.abort();
    if (caller.abortSignal?.aborted) abort();
    else caller.abortSignal?.addEventListener("abort", abort, { once: true });
    let yieldWait!: (result: Result) => void;
    const yielded = new Promise<Result>(resolve => { yieldWait = resolve; });
    const process: Process = { id, session, output: "", background: false, controller, done: undefined as never, yield: () => {
      if (process.background || process.result) return;
      process.background = true;
      caller.abortSignal?.removeEventListener("abort", abort);
      const message = `\nCommand continues in the background. Process ID: ${id}. Use process_manage to inspect or stop it.\n`;
      options?.onOutput?.(message, caller, { stream: "stdout" });
      yieldWait({ ok: true, value: { exitCode: 0 } });
    } };
    const execution = env.exec(command, { ...options, onOutput: (text, ctx, info) => {
      process.output = (process.output + text).slice(-50_000);
      if (!process.background) options?.onOutput?.(text, ctx, info);
    } }, withAbortSignal(controller.signal, withoutAbortSignal(caller)));
    process.done = execution.then(result => {
      process.result = result;
      caller.abortSignal?.removeEventListener("abort", abort);
      if (!process.background) this.processes.delete(id);
      else if (!this.closing) void this.deliver(session, `Background process ${id} finished: ${result.ok ? `exit ${result.value.exitCode}` : result.error.message}\n${process.output}`, `background:${id}`).catch(() => {});
      return result;
    });
    this.processes.set(id, process);
    return Promise.race([process.done, yielded]);
  }
  yield(session: ConversationId) { for (const process of this.processes.values()) if (process.session === session) process.yield(); }
  extension() {
    return defineExtension({ name: "busy-processes", tools: [defineTool({
      name: "process_manage", description: "List, inspect, wait for, or stop commands that continued in the background after a user correction. Processes belong to this session only.",
      parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("wait"), Type.Literal("stop")]), id: Type.Optional(Type.String()), timeoutSec: Type.Optional(Type.Number({ minimum: 0, maximum: 60 })) }),
      execute: async (args, api, caller) => {
        const text = (value: unknown, isError = false) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], isError });
        if (args.action === "list") return text([...this.processes.values()].filter(p => p.session === api.conversationId && p.background).map(p => ({ id: p.id, running: !p.result })));
        const process = args.id ? this.processes.get(args.id) : undefined;
        if (!process || process.session !== api.conversationId || !process.background) return text("No such background process in this session.", true);
        if (args.action === "stop") process.controller.abort();
        if ((args.action === "wait" || args.action === "stop") && !process.result) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let finish!: () => void;
          const abort = new Promise<void>(resolve => { finish = resolve; });
          caller.abortSignal?.addEventListener("abort", finish, { once: true });
          try { await Promise.race([process.done, new Promise<void>(resolve => { timer = setTimeout(resolve, (args.timeoutSec ?? 10) * 1000); }), abort]); }
          finally { clearTimeout(timer); caller.abortSignal?.removeEventListener("abort", finish); }
        }
        return text({ id: process.id, running: !process.result, result: process.result, output: process.output });
      },
    })] });
  }
  async close() {
    this.closing = true;
    for (const process of this.processes.values()) process.controller.abort();
    await Promise.all([...this.processes.values()].map(process => process.done));
    this.processes.clear();
  }
}
