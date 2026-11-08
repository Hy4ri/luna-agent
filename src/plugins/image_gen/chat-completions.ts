// Image generation through a configured model on an OpenAI-compatible /chat/completions endpoint.
// Works with image-output chat models such as Gemini Flash Image behind a proxy, OpenRouter, or ZenMux.
// Credentials come from the Luna model catalog; this adapter never reads or stores its own keys.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import sharp from "sharp";
import type { ImageGenProvider } from "../../image-gen.js";

const RATIO = { landscape: "16:9", square: "1:1", portrait: "9:16" } as const;
const DATA_URL = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

// Collect data URLs from the common response shapes: message.images[] (OpenRouter/proxies) and content parts.
function imageUrls(message: any): string[] {
  const urls: string[] = [];
  const take = (value: unknown) => { if (typeof value === "string" && value.startsWith("data:image/")) urls.push(value.trim()); };
  for (const item of Array.isArray(message?.images) ? message.images : []) take(item?.image_url?.url ?? item?.url);
  if (Array.isArray(message?.content)) for (const part of message.content) take(part?.image_url?.url ?? part?.url);
  else if (typeof message?.content === "string") for (const m of message.content.matchAll(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g)) take(m[0]);
  return urls;
}

export function createChatCompletionsImageProvider(options: {
  config: () => { provider?: string; model?: string };
  models: Models;
  outputDir: string;
  fetch?: typeof fetch;
}): ImageGenProvider {
  const resolve = () => {
    const { provider, model } = options.config();
    const entry = provider && model ? options.models.getModel(provider, model) : undefined;
    return entry?.api === "openai-completions" ? entry : undefined;
  };
  return {
    name: "chat-completions",
    // Local catalog check only. Credentials resolve at generation time.
    is_available: () => !!resolve(),
    capabilities: () => ({ edit: true, max_reference_images: 8 }),
    async generate(request, signal) {
      const { prompt, aspect_ratio, sources } = request;
      const modality = sources.length ? "edit" as const : "text-to-image" as const;
      const error = (error_type: string, message: string) => ({ success: false, error: message, error_type });
      try {
        signal.throwIfAborted();
        const model = resolve();
        if (!model) return error("provider_unavailable", "Select an OpenAI-compatible provider and model in image_gen.chat-completions.");
        if (sources.length > 8) return error("modality_unsupported", "This adapter accepts at most 8 source images in total.");
        const auth = await options.models.getAuth(model);
        if (!auth) return error("auth_required", `No credentials for provider "${model.provider}".`);
        signal.throwIfAborted();
        const parts: unknown[] = [{ type: "text", text: `${prompt}\n\nAspect ratio: ${RATIO[aspect_ratio]}.` }];
        for (const source of sources) {
          const bytes = await sharp(source.bytes, { limitInputPixels: 40_000_000 }).png().toBuffer();
          parts.push({ type: "image_url", image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` } });
        }
        const headers = new Headers({ "content-type": "application/json", ...model.headers });
        if (auth.auth.apiKey) headers.set("authorization", `Bearer ${auth.auth.apiKey}`);
        for (const [key, value] of Object.entries(auth.auth.headers ?? {})) {
          if (value === null) headers.delete(key); else headers.set(key, value);
        }
        const base = (auth.auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "");
        const response = await (options.fetch ?? fetch)(`${base}/chat/completions`, {
          method: "POST", headers, redirect: "error",
          body: JSON.stringify({ model: model.id, stream: false, modalities: ["image", "text"],
            image_config: { aspect_ratio: RATIO[aspect_ratio] },
            messages: [{ role: "user", content: sources.length ? parts : (parts[0] as { text: string }).text }] }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
        });
        // Do not expose server bodies: they can echo credentials or source images.
        if (!response.ok) {
          await response.body?.cancel();
          return error(response.status === 401 || response.status === 403 ? "auth_required" : "provider_http_error",
            `Chat image HTTP ${response.status}. No retry or fallback was attempted.`);
        }
        const chunks: Uint8Array[] = []; let length = 0;
        if (!response.body) return error("invalid_response", "The provider returned no response body.");
        for await (const chunk of response.body) {
          length += chunk.byteLength;
          if (length > 48 * 1024 * 1024) return error("invalid_response", "Image response exceeds 48 MiB.");
          chunks.push(chunk);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { choices?: { message?: unknown; finish_reason?: unknown }[] };
        const choice = data.choices?.[0];
        const match = imageUrls(choice?.message).map(url => DATA_URL.exec(url)).find(Boolean);
        if (!match) {
          const reason = typeof choice?.finish_reason === "string" ? ` Finish reason: ${choice.finish_reason}.` : "";
          return error("no_image", `The model returned no image. It may have refused the prompt.${reason}`);
        }
        const bytes = Buffer.from(match[2]!, "base64");
        const metadata = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: "warning" }).metadata();
        if (!metadata.format || !["png", "jpeg", "webp"].includes(metadata.format)) return error("invalid_response", "The provider returned an unsupported image format.");
        signal.throwIfAborted();
        await mkdir(options.outputDir, { recursive: true, mode: 0o700 });
        const image = join(options.outputDir, `${crypto.randomUUID()}.${metadata.format === "jpeg" ? "jpg" : metadata.format}`);
        await writeFile(image, bytes, { flag: "wx", mode: 0o600 });
        return { success: true, image, model: model.id, prompt, aspect_ratio, modality, provider: `chat-completions:${model.provider}`,
          upscaled: false, requested_size: RATIO[aspect_ratio], pixel_size: `${metadata.width}x${metadata.height}` };
      } catch {
        if (signal.aborted) return error("interrupted", "Image generation interrupted. Provider quota may already be consumed.");
        return error("provider_exception", "Chat image generation failed. No retry or fallback was attempted.");
      }
    },
  };
}
