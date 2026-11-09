// `worker_exec`: run a shell command on any registered machine ("main" or a worker), from any session.
// Tools run in the main daemon, so a worker target goes through the existing WorkerHub exec call. No protocol change.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { Type } from "typebox";
import { expandHome } from "./file-mentions.js";
import { homedir } from "node:os";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { WorkerHub } from "./workers.js";
import { WORKER_ENV_PREFIX, isWorkerEnv } from "./worker-protocol.js";

export interface MachineSources { hub: () => WorkerHub | undefined; mainEnv?: () => ExecutionEnv }
export type ResolvedMachine = { ok: true; env: ExecutionEnv; home: string | undefined; workerId: number | undefined } | { ok: false; error: string };

/** "main" or a worker name (case-insensitive) to its execution env. Unknown and offline machines are errors. */
export async function resolveMachine(o: MachineSources, machine: string): Promise<ResolvedMachine> {
  const name = machine.trim().toLowerCase();
  if (name === "main") {
    const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
    return { ok: true, env: o.mainEnv?.() ?? new NodeExecutionEnv({ cwd: homedir() }), home: homedir(), workerId: undefined };
  }
  const hub = o.hub();
  const worker = hub?.store.list().find(w => w.name.toLowerCase() === name);
  if (!hub || !worker) {
    const names = ["main", ...(hub?.store.list().map(w => w.name) ?? [])];
    return { ok: false, error: `Unknown machine "${machine}". Valid machines: ${names.join(", ")}.` };
  }
  if (!hub.view(worker.id)?.online) return { ok: false, error: `worker ${worker.name} is offline.` };
  const home = worker.capabilities?.home;
  return { ok: true, env: hub.env(worker.id, home), home, workerId: worker.id };
}

// Same limits as the built-in `bash` tool (pi-durable DEFAULT_MAX_LINES / DEFAULT_MAX_BYTES).
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

const DESCRIPTION = "Run a bash command on any Luna machine: \"main\" (the main host) or a worker name. " +
  "Works from every session regardless of its own machine. Returns combined stdout and stderr, truncated like `bash` " +
  `(last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB); a spilled full output stays on the target machine, read it with worker_exec (cat). ` +
  "Default cwd: the session cwd when the target is the session's own machine, else the target machine's home.";

export function createWorkerExecExtension(o: MachineSources) {
  return defineExtension({
    name: "worker-exec",
    tools: [defineTool({
      name: "worker_exec",
      description: DESCRIPTION,
      parameters: Type.Object({
        machine: Type.String({ minLength: 1, description: "\"main\" or a worker name (case-insensitive)." }),
        command: Type.String({ minLength: 1, description: "Bash command to execute on that machine." }),
        cwd: Type.Optional(Type.String({ minLength: 1, description: "Absolute path or ~/... on that machine." })),
        timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)." })),
      }, { additionalProperties: false }),
      structuredOutputSchema: Type.Object({
        machine: Type.String(),
        output: Type.String({ description: "Combined stdout and stderr: the retained tail" }),
        truncated: Type.Boolean(),
        fullOutputPath: Type.Optional(Type.String({ description: "File on the target machine with the complete output" })),
        exitCode: Type.Number(),
      }),
      outputLimits: { retain: "tail" },
      async execute(a, api, context: Context) {
        if (a.timeout !== undefined && (!Number.isFinite(a.timeout) || a.timeout <= 0 || a.timeout > MAX_TIMEOUT_SECONDS)) {
          throw new Error(`Invalid timeout: must be a finite number of seconds, at most ${MAX_TIMEOUT_SECONDS}`);
        }
        const target = await resolveMachine(o, a.machine);
        if (!target.ok) throw new Error(target.error);
        const label = a.machine.trim();
        const session = api.env;
        const sameMachine = !!session && (target.workerId === undefined
          ? !isWorkerEnv(session) : session.id === `${WORKER_ENV_PREFIX}${target.workerId}`);
        let cwd: string | undefined;
        if (a.cwd !== undefined) {
          cwd = expandHome(a.cwd, target.home);
          if (cwd === undefined) throw new Error(`Home directory of machine "${label}" is unknown.`);
          if (!cwd.startsWith("/")) throw new Error("cwd must be absolute or start with ~/.");
        } else {
          cwd = sameMachine ? session!.cwd : target.home;
          if (!cwd) throw new Error(`Home directory of machine "${label}" is unknown. Pass an absolute cwd.`);
        }
        // Same machine: the session env keeps its own exec setup; elsewhere the resolved env runs it.
        const env = sameMachine ? session! : target.env;
        const result = await env.exec(a.command, {
          cwd,
          env: {},
          inheritEnv: true,
          ...(a.timeout === undefined ? {} : { timeout: a.timeout }),
          onOutput: (text, _ctx, info) => api.output(text, info.skipped),
          spill: { afterBytes: MAX_BYTES, afterLines: MAX_LINES },
          ...(api.outputWindow === undefined ? {} : { window: api.outputWindow }),
        }, context);
        const spillPath = result.ok ? result.value.spillPath : result.error.spillPath;
        if (spillPath !== undefined) {
          api.diagnostic({ severity: "info", code: "full_output", message: `Full output on ${label}: ${label}:${spillPath} (read it with machine_files)` });
        }
        if (!result.ok) {
          if (result.error.code === "aborted" && context.abortSignal?.aborted) throw result.error;
          if (result.error.code === "timeout") throw new Error(`Command timed out after ${a.timeout} seconds on ${label}`);
          if (result.error.code === "aborted") throw new Error(`Command aborted on ${label}`);
          throw new Error(`${label}: ${result.error.message}`);
        }
        const exitCode = result.value.exitCode;
        const retained = api.retainedOutput();
        const structuredOutput = {
          machine: label,
          output: retained.text,
          truncated: retained.truncated,
          ...(spillPath === undefined ? {} : { fullOutputPath: spillPath }),
          exitCode,
        };
        if (exitCode === 0) return { structuredOutput };
        return { structuredOutput, isError: true, diagnostics: [{ severity: "error" as const, code: "exit_code", message: `Command exited with code ${exitCode}` }] };
      },
    })],
  });
}
