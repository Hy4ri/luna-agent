import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import sharp from "sharp";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";

export interface VisionRegion { x: number; y: number; width: number; height: number }
export interface LoadedVisionImage {
  sourceKey: string; path: string; width: number; height: number; bytes: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  cleanup(): Promise<void>;
}
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
function interrupted(signal: AbortSignal) { if (signal.aborted) throw new Error("Interrupted"); }
export function isPublicVisionAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
      a === 100 && b >= 64 && b <= 127 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 0 || b === 168 || b === 88 && c === 99) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6) return false;
  // Normalize compressed and mapped forms. Accept only global unicast 2000::/3;
  // reject special-use, translation, documentation, Teredo, and 6to4 ranges within it.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const words = normalized.split(":");
  const first = parseInt(words[0] || "0", 16), second = parseInt(words[1] || "0", 16);
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
    !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) && !(first === 0x3fff && second <= 0xfff);
}
async function resolveUrl(value: string, signal?: AbortSignal) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported image URL protocol. Use HTTP(S).");
  if (url.username || url.password) throw new Error("Image URL credentials are not allowed.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const resolution = isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true, verbatim: true });
  const addresses = signal ? await new Promise<Awaited<typeof resolution>>((done, fail) => {
    const abort = () => fail(new Error("Interrupted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    resolution.then(done, fail).finally(() => signal.removeEventListener("abort", abort));
  }) : await resolution;
  if (!addresses.length || addresses.some(a => !isPublicVisionAddress(a.address)))
    throw new Error("SSRF guard: image host must resolve only to public unicast addresses.");
  return { url, address: addresses[0]! };
}
export async function assertVisionUrl(value: string): Promise<void> { await resolveUrl(value); }
class HttpImageError extends Error { constructor(message: string, readonly retry: boolean) { super(message); } }
async function fetchBytes(value: string, signal: AbortSignal): Promise<Buffer> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let current = value;
  for (let redirects = 0; redirects <= 5; redirects++) {
    interrupted(signal);
    // Pin the exact address validated here. Keep URL host for HTTP Host and TLS SNI/certificate verification.
    const { url, address } = await resolveUrl(current, requestSignal);
    let response: { location?: string; bytes: Buffer } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await new Promise((done, fail) => {
          const req = (url.protocol === "https:" ? https : http).request(url, {
            signal: requestSignal, agent: false,
            lookup: (_host, lookupOptions, callback) => {
              if (typeof lookupOptions === "object" && lookupOptions.all) callback(null, [{ address: address.address, family: address.family }]);
              else callback(null, address.address, address.family);
            },
          }, res => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              res.destroy(); done({ location: res.headers.location, bytes: Buffer.alloc(0) }); return;
            }
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              res.destroy(); fail(new HttpImageError(`Image HTTP ${res.statusCode}`, (res.statusCode ?? 0) >= 500)); return;
            }
            const chunks: Buffer[] = []; let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_BYTES) { res.destroy(new HttpImageError("Image exceeds 32 MiB transport limit.", false)); return; }
              chunks.push(chunk);
            });
            res.on("end", () => done({ bytes: Buffer.concat(chunks) }));
            res.on("error", fail);
            res.on("aborted", () => fail(new Error("Image download aborted.")));
          });
          req.on("error", fail); req.end();
        });
        break;
      } catch (error) {
        interrupted(signal);
        if (requestSignal.aborted || attempt || error instanceof HttpImageError && !error.retry) throw error;
      }
    }
    if (!response) throw new Error("Image download failed.");
    if (!response.location) return response.bytes;
    current = new URL(response.location, current).href;
  }
  throw new Error("Image redirect limit exceeded.");
}
async function sourceBytes(source: string, cwd: string, signal: AbortSignal, env?: import("@earendil-works/pi-durable/env").ExecutionEnv): Promise<Buffer> {
  if (/^https?:/i.test(source)) return fetchBytes(source, signal);
  if (/^data:/i.test(source)) {
    if (source.length > Math.ceil(MAX_BYTES * 4 / 3) + 1024) throw new Error("Image exceeds 32 MiB transport limit.");
    const match = /^data:image\/[a-z0-9.+-]+(;base64)?,([\s\S]*)$/i.exec(source);
    if (!match) throw new Error("Invalid image data URL.");
    if (match[1]) {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(match[2]!)) throw new Error("Invalid image base64.");
      return Buffer.from(match[2]!, "base64");
    }
    return Buffer.from(decodeURIComponent(match[2]!));
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) throw new Error("Unsupported image URL protocol.");
  if (env && env.id !== "local") {
    const { withAbortSignal, BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
    const ctx = withAbortSignal(signal, BACKGROUND_CONTEXT);
    const absPath = await env.absolutePath(source, ctx);
    if (!absPath.ok) throw new Error(`Image file error: ${absPath.error.message}`);
    const read = await env.readBinaryFile(absPath.value, ctx);
    if (!read.ok) throw new Error(`Image read failed on worker: ${read.error.message}`);
    const bytes = Buffer.from(read.value);
    if (bytes.length > MAX_BYTES) throw new Error("Image exceeds 32 MiB transport limit.");
    return bytes;
  }
  const file = await open(resolve(cwd, source), "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Image must be a regular file within 32 MiB.");
    const bytes = Buffer.alloc(Math.min(MAX_BYTES + 1, stat.size + 1));
    let total = 0;
    while (total < bytes.length) {
      interrupted(signal);
      const { bytesRead } = await file.read(bytes, total, bytes.length - total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_BYTES) throw new Error("Image exceeds 32 MiB transport limit.");
    return bytes.subarray(0, total);
  } finally { await file.close(); }
}
let photon: ReturnType<typeof createNodePhotonImages> | undefined;
export async function loadVisionImage(source: string, region: VisionRegion | undefined,
  options: { signal: AbortSignal; cwd?: string; tempRoot?: string; env?: import("@earendil-works/pi-durable/env").ExecutionEnv }): Promise<LoadedVisionImage> {
  const { signal } = options;
  interrupted(signal);
  const dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), "luna-vision-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    await chmod(dir, 0o700);
    let bytes = await sourceBytes(source, options.cwd ?? process.cwd(), signal, options.env);
    interrupted(signal);
    if (bytes.length > MAX_BYTES) throw new Error("Image exceeds 32 MiB transport limit.");
    const sourceKey = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(dir, "source"), bytes, { mode: 0o600 });
    // Reject all SVG external resources before handing XML to the renderer.
    const xml = bytes.toString("utf8");
    // Normalize numeric XML entities and CSS escapes before testing resource references.
    const references = xml.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_all, code: string) => {
      const n = code[0]!.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }).replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gi, (_all, hex: string | undefined, char: string | undefined) => {
      const n = hex ? parseInt(hex, 16) : 0;
      return hex ? n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "" : char ?? "";
    });
    if (/<svg[\s>]/i.test(xml) && (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(references) ||
      /(?:href|src)\s*=\s*["']\s*(?!#)/i.test(references) || /url\s*\(\s*["']?(?!#)/i.test(references) || /@import/i.test(references)))
      throw new Error("SVG external references and entities are not allowed.");
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
      if (bytes.length < 26) throw new Error("Invalid BMP header.");
      const core = bytes.readUInt32LE(14) === 12;
      const width = core ? bytes.readUInt16LE(18) : Math.abs(bytes.readInt32LE(18));
      const height = core ? bytes.readUInt16LE(20) : Math.abs(bytes.readInt32LE(22));
      if (!width || !height || width * height > MAX_PIXELS) throw new Error("BMP exceeds decode pixel limit.");
      const prepared = await (await (photon ??= createNodePhotonImages())).prepare(Uint8Array.from(bytes), "image/bmp", {
        maxWidth: MAX_PIXELS, maxHeight: MAX_PIXELS, maxBytes: MAX_BYTES * 4,
      });
      if (!prepared) throw new Error("Invalid BMP image.");
      bytes = Buffer.from(prepared.data, "base64");
    }
    const input = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "warning" });
    const meta = await input.metadata();
    if (meta.format === "svg" && !/<svg[\s>]/i.test(xml)) throw new Error("SVG must use UTF-8 XML encoding.");
    if (!meta.width || !meta.height || meta.width * meta.height > MAX_PIXELS) throw new Error("Image exceeds decode pixel limit.");
    if (region && (!Object.values(region).every(Number.isSafeInteger) || region.x < 0 || region.y < 0 ||
      region.width < 1 || region.height < 1 || region.x + region.width > meta.width || region.y + region.height > meta.height))
      throw new Error("Image region is out of bounds or invalid.");
    // Decode even unchanged files. Extraction precedes all resizing, which happens only in fitVisionImage.
    const pipeline = region ? input.extract({ left: region.x, top: region.y, width: region.width, height: region.height }) : input;
    const mimeType = meta.format === "jpeg" ? "image/jpeg" : meta.format === "webp" ? "image/webp" : meta.format === "gif" ? "image/gif" : "image/png";
    const decoded = await pipeline.png().toBuffer();
    // Preserve original encoded bytes at full size when no crop/conversion is necessary.
    bytes = !region && ["jpeg", "png", "webp", "gif"].includes(meta.format) ? bytes : decoded;
    const actualMime = region ? "image/png" : mimeType;
    const imagePath = join(dir, "image");
    await writeFile(imagePath, bytes, { mode: 0o600 });
    interrupted(signal);
    return { sourceKey, path: imagePath, width: region?.width ?? meta.width, height: region?.height ?? meta.height,
      bytes, mimeType: actualMime, cleanup };
  } catch (error) { await cleanup(); interrupted(signal); throw error; }
}
export async function fitVisionImage(image: LoadedVisionImage,
  options: { maxBytes: number; longEdge: number; hardBytes: number; signal: AbortSignal }): Promise<{ data: string; mimeType: string; width: number; height: number }> {
  const { signal, longEdge } = options, budget = Math.min(options.maxBytes, options.hardBytes);
  if (![budget, longEdge].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid image budget or long-edge limit.");
  interrupted(signal);
  if (Math.max(image.width, image.height) <= longEdge && image.bytes.toString("base64").length <= budget)
    return { data: image.bytes.toString("base64"), mimeType: image.mimeType, width: image.width, height: image.height };
  let edge = Math.min(longEdge, Math.max(image.width, image.height));
  for (;;) {
    interrupted(signal);
    const scale = edge / Math.max(image.width, image.height);
    const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale));
    for (const quality of [85, 65, 40]) {
      const { data: bytes, info } = await sharp(image.bytes, { limitInputPixels: MAX_PIXELS }).resize(width, height, { withoutEnlargement: true }).jpeg({ quality }).toBuffer({ resolveWithObject: true });
      interrupted(signal);
      const data = bytes.toString("base64");
      if (data.length <= budget) return { data, mimeType: "image/jpeg", width: info.width, height: info.height };
    }
    if (edge <= 1) throw new Error("Image cannot fit history budget and hard byte limit.");
    edge = Math.max(1, Math.floor(edge * 0.75));
  }
}
