// Codex's native image endpoints, authenticated with ChatGPT subscription OAuth.
// Protocol: openai/codex codex-rs/{ext/image-generation,api/src/endpoint/images}.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { CodexImageAuthError, type CodexImageAuth } from "../../codex-image-auth.js";
import type { ImageGenProvider } from "../../image-gen.js";

export function createOpenAICodexImageProvider(options: {
  config: () => { model: string; quality: "low" | "medium" | "high" };
  outputDir: string;
  auth: CodexImageAuth;
  fetch?: typeof fetch;
}): ImageGenProvider {
  return {
    name: "openai-codex",
    is_available: () => options.auth.is_available(),
    capabilities: () => ({ edit: true, max_reference_images: 16 }),
    async generate(request, signal) {
      const { prompt, aspect_ratio, sources } = request;
      const { model, quality } = options.config();
      const modality = sources.length ? "edit" as const : "text-to-image" as const;
      const error = (error_type: string, message: string) => ({ success: false, error: message, error_type });
      try {
        signal.throwIfAborted();
        if (model !== "gpt-image-2") return error("model_unsupported", "The Codex adapter supports gpt-image-2.");
        if (!["low", "medium", "high"].includes(quality)) return error("invalid_arguments", "Invalid image quality.");
        if (sources.length > 16) return error("modality_unsupported", "Codex accepts at most 16 source images in total.");
        const size = { landscape: "1536x864", square: "1024x1024", portrait: "864x1536" }[aspect_ratio];
        const images: { image_url: string }[] = [];
        for (const source of sources) {
          const bytes = await sharp(source.bytes, { limitInputPixels: 40_000_000 }).png().toBuffer();
          if (bytes.length > 25 * 1024 * 1024) return error("source_rejected", "Codex source image exceeds 25 MiB.");
          images.push({ image_url: `data:image/png;base64,${bytes.toString("base64")}` });
        }
        const auth = await options.auth.resolve(signal);
        signal.throwIfAborted();
        const headers = new Headers({ authorization: `Bearer ${auth.accessToken}`, "content-type": "application/json",
          "User-Agent": "LunaPi/1.0.0", originator: "luna-pi", "x-codex-image-turn-id": crypto.randomUUID() });
        if (auth.accountId) headers.set("ChatGPT-Account-ID", auth.accountId);
        if (auth.residency) headers.set("x-openai-internal-codex-residency", auth.residency);
        const response = await (options.fetch ?? fetch)(`https://chatgpt.com/backend-api/codex/images/${sources.length ? "edits" : "generations"}`, {
          method: "POST", headers,
          body: JSON.stringify({ model, prompt, size, n: 1, quality, background: "opaque", ...(images.length ? { images } : {}) }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]), redirect: "error",
        });
        // Do not expose server bodies: they can echo tokens or source images.
        if (!response.ok) {
          await response.body?.cancel();
          return error(response.status === 401 ? "auth_required" : "provider_http_error", `Codex Images HTTP ${response.status}. No retry or API-key fallback was attempted.`);
        }
        const chunks: Uint8Array[] = []; let length = 0;
        if (!response.body) return error("invalid_response", "Codex returned no image response.");
        for await (const chunk of response.body) {
          length += chunk.byteLength;
          if (length > 48 * 1024 * 1024) return error("invalid_response", "Codex image response exceeds 48 MiB.");
          chunks.push(chunk);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data?: { b64_json?: string }[]; quality?: unknown; size?: unknown };
        const encoded = data.data?.[0]?.b64_json;
        if (typeof encoded !== "string" || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return error("invalid_response", "Codex returned no valid base64 image.");
        const bytes = Buffer.from(encoded, "base64");
        const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
        if (metadata.format !== "png") return error("invalid_response", "Codex did not return a PNG image.");
        await sharp(bytes, { limitInputPixels: 40_000_000, failOn: "warning" }).stats();
        signal.throwIfAborted();
        await mkdir(options.outputDir, { recursive: true, mode: 0o700 });
        const image = join(options.outputDir, `${crypto.randomUUID()}.png`);
        await writeFile(image, bytes, { flag: "wx", mode: 0o600 });
        // The backend can ignore size/quality. Report measured and reported values, not just the request.
        return { success: true, image, model, prompt, aspect_ratio, modality, provider: "openai-codex", upscaled: false,
          requested_size: size, pixel_size: `${metadata.width}x${metadata.height}`, requested_quality: quality,
          ...(typeof data.size === "string" ? { reported_size: data.size } : {}),
          ...(typeof data.quality === "string" ? { reported_quality: data.quality } : {}),
          ...(response.headers.get("x-codex-imagegen-request-id") ? { imagegen_request_id: response.headers.get("x-codex-imagegen-request-id")! } : {}) };
      } catch (failure) {
        if (signal.aborted) return error("interrupted", "Image generation interrupted. Subscription quota may already be consumed.");
        if (failure instanceof CodexImageAuthError) return error(failure.error_type, failure.message);
        return error("provider_exception", "Codex image generation failed. No retry or API-key fallback was attempted.");
      }
    },
  };
}
