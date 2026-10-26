// Incoming file bytes live on disk. Durable records keep metadata and stable references only.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync,
  realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const ID = /^[a-f0-9]{64}$/;
const PREFIX = "luna-upload:";
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

export class UploadError extends Error {
  constructor(readonly status: 400 | 404 | 500, message: string) { super(message); this.name = "UploadError"; }
}
export interface UploadMetadata { id: string; name: string; mimeType: string; size: number; path: string; ref: string }
export interface UploadInput { name: string; mimeType: string; data: Uint8Array }

export function workerUploadRoot(home: string, platform: string): string {
  const paths = platform === "win32" ? win32 : posix;
  if (!home || !paths.isAbsolute(home)) throw new UploadError(500, "The execution worker's home directory is unavailable.");
  return paths.join(home, ".luna", "uploads");
}
export function normalizeMimeType(raw: unknown): string {
  const value = typeof raw === "string" ? raw.split(";")[0]!.trim().toLowerCase() : "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value) ? value : "application/octet-stream";
}
function utf8Prefix(text: string, maxBytes: number): string {
  let result = "", size = 0;
  for (const character of text) {
    size += Buffer.byteLength(character);
    if (size > maxBytes) break;
    result += character;
  }
  return result;
}
export function sanitizeFilename(raw: string): string {
  let name = posix.basename((typeof raw === "string" ? raw : "upload").replace(/\\/g, "/"))
    .replace(/[\x00-\x1f\x7f/?%*:|"<>]/g, "_").trim().replace(/[. ]+$/, "");
  if (!name) name = "upload";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = "_" + name;
  if (Buffer.byteLength(name) > 200) {
    const dot = name.lastIndexOf(".");
    const suffix = dot > 0 && Buffer.byteLength(name.slice(dot)) <= 40 ? name.slice(dot) : "";
    name = utf8Prefix(suffix ? name.slice(0, dot) : name, 200 - Buffer.byteLength(suffix)) + suffix;
  }
  return name;
}
export function deriveUploadId(file: UploadInput): string {
  return createHash("sha256").update(file.name).update("\0").update(file.mimeType).update("\0").update(file.data).digest("hex");
}
const reference = (id: string, name: string) => `${PREFIX}${id}/${encodeURIComponent(name)}`;

export class UploadStore {
  readonly root: string;
  private readonly canonicalRoot: string;
  private db?: DatabaseSync;
  constructor(root: string) {
    if (!isAbsolute(root)) throw new UploadError(500, "Upload storage must use an absolute path.");
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.canonicalRoot = realpathSync(this.root);
  }
  bind(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS luna_uploads (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
      rel_path TEXT NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;`);
    this.db = db;
  }
  put(file: UploadInput): UploadMetadata {
    if (!(file?.data instanceof Uint8Array) || file.data.byteLength > MAX_UPLOAD_BYTES) {
      throw new UploadError(400, "Upload data must contain at most 32 MiB.");
    }
    const name = sanitizeFilename(file.name), mimeType = normalizeMimeType(file.mimeType);
    const id = deriveUploadId({ name, mimeType, data: file.data }), dir = join(this.root, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!inside(this.canonicalRoot, realpathSync(dir))) throw new UploadError(400, "Upload directory escaped its storage root.");
    const path = join(dir, name), temporary = join(dir, `.upload-${randomUUID()}.tmp`);
    let fd: number | undefined, created = false;
    try {
      fd = openSync(temporary, "wx", 0o600); created = true;
      writeFileSync(fd, file.data); fsyncSync(fd); closeSync(fd); fd = undefined;
      try { linkSync(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!this.readFileSafe(path).equals(Buffer.from(file.data))) throw new UploadError(500, "Stored upload contents do not match their identifier.");
      }
      if (process.platform === "linux") {
        const directory = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    } catch (error) {
      if (error instanceof UploadError) throw error;
      throw new UploadError(500, `Could not save uploaded file: ${(error as Error).message}`);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (created) { try { unlinkSync(temporary); } catch { /* Preserve a published original even if temporary cleanup fails. */ } }
    }
    this.db?.prepare("INSERT OR IGNORE INTO luna_uploads (id,name,mime_type,size,rel_path,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, name, mimeType, file.data.byteLength, posix.join(id, name), Date.now());
    return { id, name, mimeType, size: file.data.byteLength, path, ref: reference(id, name) };
  }
  get(id: string): UploadMetadata | undefined {
    if (!ID.test(id)) return undefined;
    const row = this.db?.prepare("SELECT id,name,mime_type,size,rel_path FROM luna_uploads WHERE id=?").get(id) as
      { id: string; name: string; mime_type: string; size: number; rel_path: string } | undefined;
    if (!row) return undefined;
    if (row.id !== id || sanitizeFilename(row.name) !== row.name || row.rel_path !== posix.join(id, row.name)) {
      throw new UploadError(500, "Stored upload metadata contains an invalid path.");
    }
    return { id, name: row.name, mimeType: normalizeMimeType(row.mime_type), size: row.size,
      path: join(this.root, row.rel_path), ref: reference(id, row.name) };
  }
  read(id: string): Buffer {
    const metadata = this.get(id);
    if (!metadata) throw new UploadError(404, "Uploaded file not found.");
    return this.readReference(metadata.ref, metadata.mimeType);
  }
  resolveReferencePath(ref: string): string {
    const match = /^luna-upload:([a-f0-9]{64})\/([^/]+)$/.exec(ref);
    if (!match) throw new UploadError(400, "Invalid upload reference.");
    let name: string;
    try { name = decodeURIComponent(match[2]!); } catch { throw new UploadError(400, "Invalid upload filename encoding."); }
    if (sanitizeFilename(name) !== name) throw new UploadError(400, "Invalid upload filename.");
    return join(this.root, match[1]!, name);
  }
  /** Disk-only reads also work before bind(), including resumed model requests during startup. */
  readReference(ref: string, mimeType?: string): Buffer {
    const path = this.resolveReferencePath(ref), data = this.readFileSafe(path);
    if (mimeType !== undefined) {
      const id = ref.slice(PREFIX.length, PREFIX.length + 64);
      const name = decodeURIComponent(ref.slice(PREFIX.length + 65));
      if (deriveUploadId({ name, mimeType: normalizeMimeType(mimeType), data }) !== id) {
        throw new UploadError(500, "Stored upload contents do not match their identifier.");
      }
    }
    return data;
  }
  hydrate<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(item => this.hydrate(item)) as T;
    const input = value as Record<string, unknown>, output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) output[key] = this.hydrate(item);
    if (input.type === "image" && typeof input.data === "string" && input.data.startsWith(PREFIX)) {
      output.data = this.readReference(input.data, typeof input.mimeType === "string" ? input.mimeType : undefined).toString("base64");
    }
    return output as T;
  }
  private readFileSafe(path: string): Buffer {
    if (!inside(this.root, path)) throw new UploadError(400, "Upload path escaped its storage root.");
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new UploadError(code === "ENOENT" || code === "ENOTDIR" ? 404 : 500, "Uploaded file is missing or cannot be opened safely.");
    }
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > MAX_UPLOAD_BYTES) throw new UploadError(400, "Upload must be a regular file of at most 32 MiB.");
      const actual = realpathSync(process.platform === "linux" ? `/proc/self/fd/${fd}` : path);
      if (!inside(this.canonicalRoot, actual)) throw new UploadError(400, "Opened upload escaped its storage root.");
      if (process.platform !== "linux") {
        const current = statSync(actual);
        if (lstatSync(path).isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) {
          throw new UploadError(400, "Upload changed while opening.");
        }
      }
      const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_UPLOAD_BYTES + 1));
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length === bytes.length) throw new UploadError(400, "Upload changed while reading.");
      return bytes.subarray(0, length);
    } finally { closeSync(fd); }
  }
}
