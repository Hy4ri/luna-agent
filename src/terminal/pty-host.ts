// PTY backend seam. The registry only sees these types, so node-pty can be replaced (or relayed to a worker) without touching it.
import { existsSync } from "node:fs";
import pty from "node-pty";

export interface PtySpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtyProcess {
  readonly pid: number | undefined;
  /** Shell name when the host machine chose it (a worker does). Otherwise the registry names it. */
  readonly shell?: string;
  /** Raw bytes from the terminal. Not decoded, so multi-byte sequences are never split by the host. */
  onData(listener: (data: Buffer) => void): void;
  /** `exitCode` is null when the shell's fate is unknown, such as a lost worker link; `reason` then says why. */
  onExit(listener: (exit: { exitCode: number | null; signal?: number; reason?: string }) => void): void;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** Starts a PTY on the machine a terminal belongs to. `worker` is null for the main host. */
export type PtyLauncher = (worker: number | null, options: PtySpawnOptions) => Promise<PtyProcess>;

export function spawnNodePty(options: PtySpawnOptions): PtyProcess {
  const p = pty.spawn(options.file, options.args, {
    name: "xterm-256color", cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env, encoding: null,
  });
  return {
    get pid() { return p.pid; },
    onData: listener => { p.onData(d => listener(typeof d === "string" ? Buffer.from(d) : Buffer.from(d))); },
    onExit: listener => { p.onExit(e => listener({ exitCode: e.exitCode, signal: e.signal })); },
    write: data => p.write(data),
    resize: (cols, rows) => p.resize(cols, rows),
    kill: () => p.kill(),
  };
}

/** Environment for an interactive shell. The daemon's own credentials never reach a user shell. */
export function shellEnvironment(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && k !== "LUNA_TOKEN" && k !== "LUNA_WORKER_TOKEN") env[k] = v;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

/** The user's login shell, or /bin/sh when `$SHELL` is missing or not installed. */
export function defaultShell(base: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  const shell = base.SHELL;
  return { file: shell && existsSync(shell) ? shell : "/bin/sh", args: ["-l"] };
}

/** Launcher for the main host. Worker machines are handled by a relay launcher. */
export const localLauncher: PtyLauncher = async (worker, options) => {
  if (worker !== null) throw new Error("Local launcher cannot start a terminal on a worker.");
  return spawnNodePty(options);
};
