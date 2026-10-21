// Provider-neutral image generation. Source pixels are validated before provider dispatch.
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type, type TSchema } from "typebox";
import { loadVisionImage, fitVisionImage } from "./vision-images.js";
import { confinedReader, isWorkerEnv } from "./worker-protocol.js";

export type AspectRatio = "landscape" | "square" | "portrait";
export type CreativeControl = "creativity" | "intensity" | "complexity" | "movement";
export interface ImageGenCapabilities { edit?: boolean; max_reference_images?: number; upscale?: boolean; controls?: CreativeControl[] }
export interface ImageGenSource { bytes: Buffer; mimeType: string }
export interface ImageGenRequest extends Record<string, unknown> { prompt: string; aspect_ratio: AspectRatio; sources: ImageGenSource[] }
export interface ImageGenResult {
  success: boolean; image?: string; model?: string; prompt?: string; aspect_ratio?: AspectRatio;
  modality?: "edit" | "text-to-image"; provider?: string; upscaled?: boolean; error?: string; error_type?: string;
  requested_size?: string; pixel_size?: string; requested_quality?: string; reported_size?: string; reported_quality?: string; imagegen_request_id?: string;
}
export interface ImageGenProvider {
  name: string;
  // Availability must be a local check. Never probe unselected providers or issue billable requests.
  is_available(): boolean;
  capabilities(): ImageGenCapabilities;
  generate(request: ImageGenRequest, signal: AbortSignal): Promise<ImageGenResult>;
}
const fail = (error_type: string, error: string): ImageGenResult => ({ success: false, error, error_type });
const gateways = new Set(["nous", "krea", "portal"]);
function schema(caps: ImageGenCapabilities) {
  const properties: Record<string, TSchema> = {
    prompt: Type.String({ minLength: 1 }),
    aspect_ratio: Type.Optional(Type.Union([Type.Literal("landscape"), Type.Literal("square"), Type.Literal("portrait")], { default: "landscape", description: "Landscape is 16:9; portrait is 9:16." })),
  };
  if (caps.edit) properties.image_url = Type.Optional(Type.String({ minLength: 1 }));
  if (caps.max_reference_images) properties.reference_image_urls = Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: caps.max_reference_images }));
  if (caps.upscale) properties.upscale = Type.Optional(Type.Boolean());
  for (const control of caps.controls ?? []) properties[control] = Type.Optional(Type.Number());
  return Type.Object(properties, { additionalProperties: false });
}
async function source(value: unknown, cwd: string, signal: AbortSignal, env?: import("@earendil-works/pi-durable/env").ExecutionEnv): Promise<ImageGenSource> {
  if (typeof value !== "string" || !value.trim()) throw new Error("Image sources must be nonempty strings.");
  let input = value;
  if (!/^https?:|^data:/i.test(value)) {
    if (env && isWorkerEnv(env)) {
      // One worker-side open: confinement is checked on the opened file and the bytes come from it.
      const reader = confinedReader(env);
      if (!reader) throw new Error("This execution machine cannot read source images safely. Update the worker.");
      const { withAbortSignal, BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
      const read = await reader.readConfined(value, { root: env.cwd || cwd, maxBytes: 32 * 1024 * 1024 }, withAbortSignal(signal, BACKGROUND_CONTEXT));
      if (!read.ok) throw new Error(/outside the conversation working directory/.test(read.error.message)
        ? "Source image is outside the conversation working directory." : `Source image read failed on worker: ${read.error.message}`);
      const bytes = Buffer.from(read.value);
      const sharp = (await import("sharp")).default;
      const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
      const mime = metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`;
      input = `data:${mime};base64,${bytes.toString("base64")}`;
    } else {
    // Inspect the open descriptor, not just the pathname. A symlink swap cannot change what gets uploaded.
    const root = await realpath(cwd);
    const file = await open(resolve(root, value), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const actual = await realpath(`/proc/self/fd/${file.fd}`), rel = relative(root, actual);
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Source image is outside the conversation working directory.");
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Source must be a regular image file of at most 32 MiB.");
      signal.throwIfAborted();
      const buffer = Buffer.alloc(32 * 1024 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length === buffer.length) throw new Error("Source image exceeds 32 MiB.");
      const bytes = buffer.subarray(0, length);
      // Let the image decoder determine the type, without trusting the file extension.
      const sharp = (await import("sharp")).default;
      const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
      const mime = metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`;
      input = `data:${mime};base64,${bytes.toString("base64")}`;
    } finally { await file.close(); }
    }
  }
  const loaded = await loadVisionImage(input, undefined, { cwd, signal });
  try { return { bytes: loaded.bytes, mimeType: loaded.mimeType }; } finally { await loaded.cleanup(); }
}
export class ImageGenManager {
  constructor(private options: {
    config: () => { provider?: string };
    providers: ReadonlyMap<string, ImageGenProvider>;
    refresh?: () => void | Promise<void>;
  }) {}
  private selected() { const name = this.options.config().provider; return name ? this.options.providers.get(name) : undefined; }
  available() {
    try { return !!this.selected()?.is_available(); } catch { return false; }
  }
  parameters() { return schema(this.selected()?.capabilities() ?? {}); }
  async generate(args: Record<string, unknown>, execution: { cwd: string; signal: AbortSignal; backend?: string; env?: import("@earendil-works/pi-durable/env").ExecutionEnv }): Promise<ImageGenResult> {
    const { signal, cwd } = execution;
    try {
      signal.throwIfAborted();
      if (typeof args.prompt !== "string" || !args.prompt.trim()) return fail("invalid_prompt", "Prompt must not be empty.");
      const aspect = args.aspect_ratio ?? "landscape";
      if (!["landscape", "square", "portrait"].includes(aspect as string)) return fail("invalid_arguments", "Invalid aspect ratio.");
      if (execution.backend && execution.backend !== "local") return fail("backend_unsupported", "Remote image synchronization is not implemented.");
      let sources: ImageGenSource[];
      try {
        if (args.reference_image_urls !== undefined && !Array.isArray(args.reference_image_urls)) throw new Error("reference_image_urls must be an array.");
        const refs = (args.reference_image_urls ?? []) as unknown[];
        sources = [];
        for (const value of [...(args.image_url !== undefined ? [args.image_url] : []), ...refs]) sources.push(await source(value, cwd, signal, execution.env));
      } catch (error) {
        if (signal.aborted) throw error;
        return fail("source_rejected", error instanceof Error ? error.message : "Invalid source image.");
      }
      const name = this.options.config().provider;
      if (!name) return fail("provider_unselected", "Select image_gen.provider explicitly.");
      if (gateways.has(name)) return fail("gateway_unsupported", "Managed image gateways are not implemented.");
      let provider = this.options.providers.get(name);
      if (!provider) { await this.options.refresh?.(); provider = this.options.providers.get(name); }
      if (!provider) return fail("provider_not_registered", `Image provider "${name}" is not registered.`);
      if (!provider.is_available()) return fail("provider_unavailable", `Image provider "${name}" is unavailable.`);
      const caps = provider.capabilities();
      const references = (args.reference_image_urls as unknown[] | undefined)?.length ?? 0;
      if (args.image_url !== undefined && !caps.edit || references > (caps.max_reference_images ?? 0) || sources.length && !caps.edit)
        return fail("modality_unsupported", "This provider does not support the requested source images.");
      const request: ImageGenRequest = { prompt: args.prompt, aspect_ratio: aspect as AspectRatio, sources };
      for (const control of caps.controls ?? []) if (args[control] !== undefined) {
        if (typeof args[control] !== "number" || !Number.isFinite(args[control])) return fail("invalid_arguments", `${control} must be a finite number.`);
        request[control] = args[control];
      }
      if (caps.upscale && args.upscale !== undefined) {
        if (typeof args.upscale !== "boolean") return fail("invalid_arguments", "upscale must be a boolean.");
        request.upscale = args.upscale;
      }
      signal.throwIfAborted();
      // JS TypeError is not Python's unexpected-keyword exception. Modalities are checked above.
      const result = await provider.generate(request, signal);
      signal.throwIfAborted();
      if (result.success && result.image && execution.env && isWorkerEnv(execution.env)) {
        try {
          const { readFile } = await import("node:fs/promises");
          const { basename } = await import("node:path");
          const bytes = await readFile(result.image);
          const filename = basename(result.image);
          const { withAbortSignal, BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
          const ctx = withAbortSignal(signal, BACKGROUND_CONTEXT);
          const targetDir = execution.env.cwd || execution.cwd;
          const target = await execution.env.joinPath([targetDir, filename], ctx);
          // The provider already charged for this image. Report delivery failure distinctly and keep the main copy.
          const delivery = (detail: string): ImageGenResult => ({ ...result, success: false, error_type: "worker_delivery_failed",
            error: `Image generated and saved on the main host at ${result.image}, but delivery to the execution machine failed: ${detail}. Do not regenerate automatically.` });
          if (!target.ok) return delivery(target.error.message);
          const written = await execution.env.writeFile(target.value, new Uint8Array(bytes), ctx);
          if (!written.ok) return delivery(written.error.message);
          result.image = target.value;
        } catch (e) {
          if (signal.aborted) throw e;
          return { ...result, success: false, error_type: "worker_delivery_failed",
            error: `Image generated and saved on the main host at ${result.image}, but delivery to the execution machine failed: ${e instanceof Error ? e.message : String(e)}. Do not regenerate automatically.` };
        }
      }
      return result;
    } catch {
      return signal.aborted ? fail("interrupted", "Image generation interrupted. A submitted request may already consume provider quota.")
        : fail("provider_exception", "Image provider failed. No fallback or automatic retry was attempted.");
    }
  }
}
export function createImageGenExtension(manager: ImageGenManager, defaultCwd = process.cwd()) {
  return defineExtension({ name: "image-gen", get tools() {
    // The registry resolves this getter for each tool listing, including existing conversations.
    if (!manager.available()) return [];
    return [defineTool({
      name: "image_generate", executionMode: "sequential", replay: "unsafe",
      description: "Generate or edit an image with the explicitly selected provider. This consumes the selected provider's quota. Returns a local image path and preview. Use vision_analyze to inspect it.",
      parameters: manager.parameters(),
      async execute(args, api, context) {
        const agent = await api.agent(context), signal = context.abortSignal ?? new AbortController().signal;
        const result = await manager.generate(args, { cwd: agent.cwd ?? defaultCwd, signal, env: api.env });
        const output: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: JSON.stringify(result) }];
        if (result.success && result.image) {
          try {
            const image = await loadVisionImage(result.image, undefined, { signal, cwd: agent.cwd, env: api.env });
            try { const preview = await fitVisionImage(image, { maxBytes: 256 * 1024, hardBytes: 1024 * 1024, longEdge: 2048, signal }); output.push({ type: "image", data: preview.data, mimeType: preview.mimeType }); }
            finally { await image.cleanup(); }
          } catch {
            // Generation already succeeded. Preserve its path; never imply that a second paid request is necessary.
            output.push({ type: "text", text: "Image saved, but preview delivery failed. Use the returned image path; do not regenerate automatically." });
          }
        }
        return { output, ...(result.success ? {} : { isError: true }) };
      },
    })];
  } });
}
