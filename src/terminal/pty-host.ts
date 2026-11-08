// PTY backend seam. The registry only sees these types, so Bun.Terminal can be relayed to a worker without touching it.
import { existsSync } from "node:fs";

export interface PtySpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** The program line when the terminal runs one program, for launchers that pick the shell themselves. */
  command?: string;
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

export function spawnBunPty(options: PtySpawnOptions): PtyProcess {
  const dataListeners: ((data: Buffer) => void)[] = [];
  const exitListeners: ((exit: { exitCode: number | null; signal?: number; reason?: string }) => void)[] = [];
  const earlyData: Buffer[] = [];
  let exitResult: { exitCode: number | null; signal?: number; reason?: string } | undefined;

  const proc = Bun.spawn([options.file, ...options.args], {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      cols: options.cols,
      rows: options.rows,
      name: "xterm-256color",
      data(_term, chunk) {
        const buf = Buffer.from(chunk);
        if (dataListeners.length === 0) earlyData.push(buf);
        else for (const fn of dataListeners) fn(buf);
      },
    },
  });

  void proc.exited.then((code) => {
    try { proc.terminal?.close(); } catch { /* already closed */ }
    const sig = typeof proc.signalCode === "number" ? proc.signalCode : undefined;
    exitResult = { exitCode: code ?? null, ...(sig !== undefined ? { signal: sig } : {}) };
    for (const fn of exitListeners) fn(exitResult);
  });

  return {
    get pid() { return proc.pid; },
    onData: listener => {
      dataListeners.push(listener);
      for (const buf of earlyData.splice(0)) listener(buf);
    },
    onExit: listener => {
      exitListeners.push(listener);
      if (exitResult) listener(exitResult);
    },
    write: data => { try { proc.terminal?.write(data); } catch { /* closed */ } },
    resize: (cols, rows) => { try { proc.terminal?.resize(cols, rows); } catch { /* closed */ } },
    kill: () => {
      try { proc.kill(); } catch { /* exited */ }
      try { proc.terminal?.close(); } catch { /* closed */ }
    },
  };
}

export const spawnNodePty = spawnBunPty;

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

/** Run one command line through the login shell, so PATH and aliases match an interactive shell. */
export function programInvocation(shell: string, command: string): { file: string; args: string[] } {
  return { file: shell, args: ["-lc", command] };
}

/** Launcher for the main host. Worker machines are handled by a relay launcher. */
export const localLauncher: PtyLauncher = async (worker, options) => {
  if (worker !== null) throw new Error("Local launcher cannot start a terminal on a worker.");
  return spawnBunPty(options);
};
