// OpenAI speed tiers. A session stores the speed the user picked; each provider request sends it as `service_tier`.
// Fast (formerly Priority processing) runs up to 2.5x faster at about 2x the price. Ultrafast runs up to 6-8x faster at
// about 6x the price, only on gpt-6-astra and gpt-6.1-sol.
import type { Api, MutableModels, Model } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";

export const SPEEDS = ["fast", "ultrafast"] as const;
export type Speed = (typeof SPEEDS)[number];

export const SpeedDoc = defineDoc<{ speed: Speed | null }>({
  checkpointWhen: () => false,
  kind: "luna.speed", version: 1, scope: "conversation", history: "latest", fork: "current",
  initial: () => ({ speed: null }),
});

const OPENAI_PROVIDERS = new Set(["openai", "openai-codex"]);
const TIER_APIS = new Set(["openai-responses", "openai-codex-responses"]);
const ULTRAFAST_MODELS = new Set(["gpt-6-astra", "gpt-6.1-sol"]);
const LONG_CONTEXT_SUFFIX = "-long-context";

/** Speeds the model accepts, slowest first. Empty for models without OpenAI service tiers. */
export function supportedSpeeds(model: Pick<Model<Api>, "provider" | "api" | "id"> | undefined): Speed[] {
  if (!model || !OPENAI_PROVIDERS.has(model.provider) || !TIER_APIS.has(model.api) || !model.id.startsWith("gpt-")) return [];
  const id = model.id.endsWith(LONG_CONTEXT_SUFFIX) ? model.id.slice(0, -LONG_CONTEXT_SUFFIX.length) : model.id;
  return ULTRAFAST_MODELS.has(id) ? ["fast", "ultrafast"] : ["fast"];
}

/** The speed a request runs: Ultrafast falls back to Fast on models without it; unsupported speeds run standard. */
export function effectiveSpeed(model: Pick<Model<Api>, "provider" | "api" | "id">, speed: Speed | null | undefined): Speed | undefined {
  if (!speed) return undefined;
  const speeds = supportedSpeeds(model);
  if (speeds.includes(speed)) return speed;
  return speed === "ultrafast" && speeds.includes("fast") ? "fast" : undefined;
}

// "priority" is the name every OpenAI model and the Codex backend accept for Fast; "fast" is only an alias.
const TIER: Record<Speed, string> = { fast: "priority", ultrafast: "ultrafast" };

/** Sets `service_tier` on OpenAI Responses bodies for sessions with a speed. */
export function createSpeedExtension() {
  return defineExtension({
    name: "speed",
    hooks: [hook(GenerationTask, {
      beforeProviderRequest: async ({ model, payload }, api, context) => {
        if (!TIER_APIS.has(model.api) || !payload || typeof payload !== "object") return undefined;
        const speed = effectiveSpeed(model, (await api.snapshot(SpeedDoc, api.conversationId, context))?.speed);
        return speed ? { payload: { ...(payload as object), service_tier: TIER[speed] } } : undefined;
      },
    })],
  });
}

type TierOptions = { serviceTier?: unknown; onPayload?: (payload: unknown, model: Model<Api>) => unknown } | undefined;

/**
 * pi-ai prices a response by its `service_tier`, and the Codex backend reports "default" for tiered requests, so it also
 * needs the requested tier. Copy the tier the payload hooks set into the request options before pi-ai reads them.
 */
export function withSpeedPricing(models: MutableModels): MutableModels {
  return new Proxy(models, {
    get(target, prop, receiver) {
      if (prop === "streamSimple" || prop === "completeSimple") {
        const fn = (target[prop] as (...a: unknown[]) => unknown).bind(target);
        return (model: Model<Api>, context: unknown, options?: TierOptions) => {
          if (!options?.onPayload || !TIER_APIS.has(model.api)) return fn(model, context, options);
          const onPayload = options.onPayload;
          const wrapped: NonNullable<TierOptions> = { ...options };
          wrapped.onPayload = async (payload, m) => {
            const replaced = await onPayload(payload, m);
            const tier = ((replaced ?? payload) as { service_tier?: unknown } | null)?.service_tier;
            if (typeof tier === "string") wrapped.serviceTier = tier;
            return replaced;
          };
          return fn(model, context, wrapped);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
