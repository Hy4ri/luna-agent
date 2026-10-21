// Policy-checked file read that runs on the machine that owns the file.
// The file is opened once. Every check uses the opened descriptor, and the bytes come from that same descriptor,
// so a path or parent swapped for a symlink after the check cannot redirect the read.
import { constants } from "node:fs";
import { open, realpath, stat as fileStat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface ConfinedReadPolicy {
  /** The opened file must be inside this directory (resolved against cwd, then canonicalized). */
  root?: string;
  /** The opened file must not be inside, or a hard-link alias of, these paths (resolved against cwd). */
  blocked?: string[];
  /** Refuse files whose canonical path has a credential component (.ssh, .env, auth.json, ...). */
  credentials?: boolean;
  maxBytes: number;
}

export const within = (file: string, dir: string) => file === dir || file.startsWith(dir.endsWith(sep) ? dir : dir + sep);
export const credentialPath = (path: string) => path.split(sep).some(p => /^\.env(?:\.|$)|^\.(?:ssh|aws|gnupg)$|^(?:auth|credentials|secrets)\.json$|^luna\.config(?:\.[^/]+)?\.json$/i.test(p));

/** Raised for policy refusals. The message is safe to show to the model. */
export class ConfinedReadError extends Error {}

export async function confinedRead(path: string, policy: ConfinedReadPolicy, options: { cwd: string; signal?: AbortSignal;
  /** Test hook: runs after open and before validation. */
  afterOpen?: () => Promise<void> }): Promise<Uint8Array> {
  if (typeof path !== "string" || !path) throw new ConfinedReadError("Invalid source path.");
  if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 1) throw new ConfinedReadError("Invalid read limit.");
  if (process.platform !== "linux") throw new ConfinedReadError("Protected media reads need a Linux execution machine.");
  const target = resolve(options.cwd, path);
  // Resolve the policy paths first. Then a later swap of these paths cannot widen the check.
  const root = policy.root === undefined ? undefined : await realpath(resolve(options.cwd, policy.root)).catch(() => {
    throw new ConfinedReadError("The working directory is not available on the execution machine.");
  });
  const blocked: string[] = [];
  for (const value of policy.blocked ?? []) {
    const abs = resolve(options.cwd, value);
    blocked.push(abs, await realpath(abs).catch(() => abs));
  }
  const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK); // Symlinks are followed; the opened file is checked.
  try {
    await options.afterOpen?.();
    // /proc/self/fd names the opened file, not the path it was opened by.
    // A file deleted after open has no path to check. Refuse it.
    const actual = await realpath(`/proc/self/fd/${file.fd}`).catch(() => { throw new ConfinedReadError("Source changed while it was opened."); });
    if (root !== undefined) {
      const rel = relative(root, actual);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ConfinedReadError("Source is outside the conversation working directory.");
    }
    if (policy.credentials && credentialPath(actual)) throw new ConfinedReadError("Read blocked: credential file.");
    if (blocked.some(dir => within(actual, dir))) throw new ConfinedReadError("Read blocked: protected credential or blocked path.");
    const stat = await file.stat();
    for (const value of blocked) {
      const other = await fileStat(value).catch(() => undefined);
      if (other?.isFile() && other.dev === stat.dev && other.ino === stat.ino) throw new ConfinedReadError("Read blocked: credential file alias.");
    }
    if (!stat.isFile()) throw new ConfinedReadError("Source must be a regular file.");
    if (stat.size > policy.maxBytes) throw new ConfinedReadError(`Source exceeds the ${policy.maxBytes}-byte limit.`);
    const buffer = Buffer.alloc(Math.min(policy.maxBytes + 1, stat.size + 1));
    let length = 0;
    while (length < buffer.length) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    // The file can grow after stat. Never return more than the limit or a partial read.
    if (length > policy.maxBytes) throw new ConfinedReadError(`Source exceeds the ${policy.maxBytes}-byte limit.`);
    if (length === buffer.length) throw new ConfinedReadError("Source changed while it was read.");
    return new Uint8Array(buffer.buffer, buffer.byteOffset, length);
  } finally { await file.close(); }
}
