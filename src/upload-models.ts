import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  ModelsApiStreamOptions,
  ModelsSimpleStreamOptions,
  MutableModels,
} from "@earendil-works/pi-ai";
import type { UploadStore } from "./uploads.js";

/**
 * Hydrates only `context.messages` while leaving `systemPrompt`, `tools`, and any
 * other top-level context properties completely unchanged. This prevents deep-cloning
 * of tool schemas that may contain symbol keys or non-JSON metadata.
 */
function hydrateRequestContext(context: Context, uploads: UploadStore): Context {
  if (!context || !Array.isArray(context.messages)) {
    return context;
  }
  return {
    ...context,
    messages: uploads.hydrate(context.messages),
  };
}

/**
 * Wraps a MutableModels collection with a transparent proxy that hydrates
 * request contexts containing luna-upload references right before model dispatch.
 *
 * Wraps all four request entrypoints:
 * - stream
 * - streamSimple
 * - complete
 * - completeSimple
 *
 * All other methods and properties are bound to the underlying target.
 * Context hydration is pure and never mutates the stored/caller's context.
 */
export function withUploadModels(models: MutableModels, uploads: UploadStore): MutableModels {
  return new Proxy(models, {
    get(target, prop, receiver) {
      if (prop === "stream") {
        return function stream<TApi extends Api>(
          model: Model<TApi>,
          context: Context,
          options?: ModelsApiStreamOptions<TApi>
        ): AssistantMessageEventStream {
          const hydratedContext = hydrateRequestContext(context, uploads);
          return target.stream(model, hydratedContext, options);
        };
      }

      if (prop === "streamSimple") {
        return function streamSimple(
          model: Model<Api>,
          context: Context,
          options?: ModelsSimpleStreamOptions
        ): AssistantMessageEventStream {
          const hydratedContext = hydrateRequestContext(context, uploads);
          return target.streamSimple(model, hydratedContext, options);
        };
      }

      if (prop === "complete") {
        return function complete<TApi extends Api>(
          model: Model<TApi>,
          context: Context,
          options?: ModelsApiStreamOptions<TApi>
        ): Promise<AssistantMessage> {
          const hydratedContext = hydrateRequestContext(context, uploads);
          return target.complete(model, hydratedContext, options);
        };
      }

      if (prop === "completeSimple") {
        return function completeSimple(
          model: Model<Api>,
          context: Context,
          options?: ModelsSimpleStreamOptions
        ): Promise<AssistantMessage> {
          const hydratedContext = hydrateRequestContext(context, uploads);
          return target.completeSimple(model, hydratedContext, options);
        };
      }

      const val = Reflect.get(target, prop, receiver);
      if (typeof val === "function") {
        return val.bind(target);
      }
      return val;
    },
  });
}
