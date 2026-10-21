import { constants } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm, stat as fileStat, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isPublicVisionAddress } from "./vision-images.js";

export const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
export const VIDEO_WARNING_BYTES = 20 * 1024 * 1024;
export const VIDEO_DOWNLOAD_TIMEOUT = 60_000;
export interface VideoSourceOptions {
  signal: AbortSignal; cwd?: string; dataDir: string; configPath?: string;
  blocked_paths: string[]; blocked_hosts: string[];
  env?: import("@earendil-works/pi-durable/env").ExecutionEnv;
}
export function videoMime(source: string): string {
  const suffix = extname(/^https?:/i.test(source) ? new URL(source).pathname : source).toLowerCase();
  const mime: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mpeg": "video/mpeg", ".mpg": "video/mpeg", ".avi": "video/mp4", ".mkv": "video/mp4" };
  if (!mime[suffix]) throw new Error("Unsupported video format");
  return mime[suffix];
}
function check(signal: AbortSignal) { if (signal.aborted) throw new Error("Interrupted"); }
class DownloadError extends Error { constructor(message: string, readonly retry = false) { super(message); } }
async function checkedUrl(source: string, options: VideoSourceOptions, signal: AbortSignal) {
  const url = new URL(source);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new DownloadError("Site access denied: use HTTP(S) without credentials.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (options.blocked_hosts.some(value => { const blocked = value.toLowerCase().replace(/\.$/, ""); return host === blocked || host.endsWith(`.${blocked}`); }))
    throw new DownloadError("Site access denied by video.blocked_hosts.");
  const pending = isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : lookup(host, { all: true, verbatim: true });
  const addresses = await new Promise<Awaited<typeof pending>>((done, fail) => {
    const abort = () => fail(signal.reason ?? new Error("Interrupted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending.then(done, fail).finally(() => signal.removeEventListener("abort", abort));
  });
  if (!addresses.length || addresses.some(a => !isPublicVisionAddress(a.address)))
    throw new DownloadError("SSRF guard: video host must resolve only to public addresses.");
  return { url, address: addresses[0]! };
}
async function download(source: string, options: VideoSourceOptions): Promise<Buffer> {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT)]);
    try {
      let current = source;
      for (let redirects = 0; redirects <= 5; redirects++) {
        check(options.signal);
        const { url, address } = await checkedUrl(current, options, signal);
        const response = await new Promise<{ location?: string; bytes: Buffer }>((done, fail) => {
          const req = (url.protocol === "https:" ? https : http).request(url, {
            signal, agent: false,
            lookup: (_host, lookupOptions, callback) => {
              if (typeof lookupOptions === "object" && lookupOptions.all) callback(null, [{ address: address.address, family: address.family }]);
              else callback(null, address.address, address.family);
            },
          }, res => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              res.destroy(); done({ location: res.headers.location, bytes: Buffer.alloc(0) }); return;
            }
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              res.destroy(); fail(new DownloadError(`Video HTTP ${res.statusCode}`, (res.statusCode ?? 0) >= 500 || res.statusCode === 429)); return;
            }
            if (Number(res.headers["content-length"]) > VIDEO_MAX_BYTES) {
              res.destroy(); fail(new DownloadError("Video exceeds 50 MiB transport limit; compress or trim.")); return;
            }
            const chunks: Buffer[] = []; let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > VIDEO_MAX_BYTES) { res.destroy(new DownloadError("Video exceeds 50 MiB transport limit; compress or trim.")); return; }
              chunks.push(chunk);
            });
            res.on("end", () => done({ bytes: Buffer.concat(chunks) }));
            res.on("error", fail);
            res.on("aborted", () => fail(new Error("Video download aborted.")));
          });
          req.on("error", fail); req.end();
        });
        if (!response.location) return response.bytes;
        current = new URL(response.location, current).href;
      }
      throw new DownloadError("Video redirect limit exceeded.");
    } catch (error) {
      check(options.signal);
      if (attempt === 3 || error instanceof DownloadError && !error.retry) {
        if (signal.aborted) throw new Error("Video download timed out after 60 seconds per attempt.");
        throw error;
      }
    }
  }
  throw new Error("Video download failed.");
}
const within = (file: string, blocked: string) => file === blocked || file.startsWith(blocked + sep);
const credentialPath = (path: string) => path.split(sep).some(p => /^\.env(?:\.|$)|^\.(?:ssh|aws|gnupg)$|^(?:auth|credentials|secrets)\.json$|^luna\.config(?:\.[^/]+)?\.json$/i.test(p));
async function localBytes(source: string, options: VideoSourceOptions): Promise<Buffer> {
  if (options.env && options.env.id !== "local") {
    const { withAbortSignal, BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
    const ctx = withAbortSignal(options.signal, BACKGROUND_CONTEXT);
    const absPath = await options.env.absolutePath(source, ctx);
    if (!absPath.ok) throw new Error(`Video file error: ${absPath.error.message}`);
    // Fail closed: a path the worker cannot canonicalize is not read.
    const canonical = await options.env.canonicalPath(absPath.value, ctx);
    if (!canonical.ok) throw new Error(`Invalid video source: ${canonical.error.message}`);
    const path = canonical.value;
    // Main-host paths (dataDir, configPath) do not exist on the worker. Resolve blocked_paths on the worker.
    for (const value of options.blocked_paths) {
      const abs = await options.env.absolutePath(value, ctx);
      if (!abs.ok) continue;
      const real = await options.env.canonicalPath(abs.value, ctx);
      const blocked = real.ok ? real.value : abs.value;
      if (within(path, blocked) || within(absPath.value, abs.value)) throw new Error("Read blocked: protected credential or video.blocked_paths.");
    }
    if (credentialPath(path)) throw new Error("Read blocked: credential file.");
    const info = await options.env.fileInfo(path, ctx);
    if (!info.ok || info.value.kind !== "file") throw new Error("Invalid video source: expected a regular local file.");
    if (info.value.size > VIDEO_MAX_BYTES) throw new Error("Video exceeds 50 MiB transport limit; compress or trim.");
    const read = await options.env.readBinaryFile(path, ctx);
    if (!read.ok) throw new Error(`Invalid video source: failed to read from worker: ${read.error.message}`);
    const bytes = Buffer.from(read.value);
    if (bytes.length > VIDEO_MAX_BYTES) throw new Error("Video exceeds 50 MiB transport limit; compress or trim.");
    return bytes;
  }
  const path = await realpath(resolve(options.cwd ?? process.cwd(), source));
  const protectedPaths = [join(options.dataDir, "auth.json"), join(options.dataDir, "mcp.json"),
    options.configPath, join(homedir(), ".ssh"), join(homedir(), ".aws"), join(homedir(), ".gnupg"),
    ...options.blocked_paths].filter((p): p is string => !!p);
  const canonicalBlocks: string[] = [];
  for (const value of protectedPaths) {
    const blocked = resolve(options.cwd ?? process.cwd(), value);
    const canonical = await realpath(blocked).catch(() => blocked);
    canonicalBlocks.push(canonical);
    if (within(path, canonical)) throw new Error("Read blocked: protected credential or video.blocked_paths.");
  }
  // Check canonical path components too: a symlink cannot rename a known credential directory.
  if (credentialPath(path))
    throw new Error("Read blocked: credential file.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    const openedPath = await realpath(`/proc/self/fd/${file.fd}`).catch(() => path);
    if (credentialPath(openedPath) || canonicalBlocks.some(blocked => within(openedPath, blocked))) throw new Error("Read blocked: protected credential or video.blocked_paths.");
    for (const blocked of canonicalBlocks) {
      const protectedStat = await fileStat(blocked).catch(() => undefined);
      if (protectedStat?.isFile() && protectedStat.dev === stat.dev && protectedStat.ino === stat.ino)
        throw new Error("Read blocked: credential file alias.");
    }
    if (!stat.isFile()) throw new Error("Invalid video source: expected a regular local file.");
    if (stat.size > VIDEO_MAX_BYTES) throw new Error("Video exceeds 50 MiB transport limit; compress or trim.");
    // Bound reads even if a file grows after stat.
    const bytes = Buffer.alloc(Math.min(VIDEO_MAX_BYTES + 1, stat.size + 1)); let total = 0;
    while (total < bytes.length) {
      check(options.signal);
      const { bytesRead } = await file.read(bytes, total, bytes.length - total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > VIDEO_MAX_BYTES || total > stat.size) throw new Error("Video changed during read or exceeds transport limit.");
    return bytes.subarray(0, total);
  } finally { await file.close(); }
}
export async function materializeVideo(source: string, options: VideoSourceOptions) {
  check(options.signal);
  if (!source.trim() || /^[a-z][a-z0-9+.-]*:/i.test(source) && !/^https?:\/\//i.test(source))
    throw new Error("Invalid video source");
  const mimeType = videoMime(source);
  let dir: string | undefined;
  const cleanup = async () => { if (dir) await rm(dir, { recursive: true, force: true }); };
  try {
    let bytes: Buffer;
    if (/^https?:\/\//i.test(source)) {
      const root = join(options.dataDir, "video-cache");
      await mkdir(root, { recursive: true, mode: 0o700 });
      dir = await mkdtemp(join(root, "download-"));
      bytes = await download(source, options);
      await writeFile(join(dir, "video"), bytes, { mode: 0o600 });
    } else bytes = await localBytes(source, options);
    check(options.signal);
    const data = bytes.toString("base64");
    if (data.length > VIDEO_MAX_BYTES) throw new Error("Video base64 payload exceeds 50 MiB; compress or trim.");
    return { mimeType, data, warning: bytes.length > VIDEO_WARNING_BYTES ? "Video exceeds 20 MiB. Analysis can be slow or rejected." : undefined, cleanup };
  } catch (error) { await cleanup(); check(options.signal); throw error; }
}
