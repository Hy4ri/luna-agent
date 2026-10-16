// Luna HTTP/SSE daemon. Env: LUNA_PORT (8787), LUNA_HOST (127.0.0.1), LUNA_TOKEN, LUNA_DB (luna.db),
// LUNA_PROVIDER (openai|anthropic|faux), LUNA_MODEL, LUNA_CWD.
import { serve } from "@hono/node-server";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { context, openLuna } from "./luna.js";
import { createApp } from "./server.js";

const env = process.env;
const host = env.LUNA_HOST ?? "127.0.0.1";
const port = Number(env.LUNA_PORT ?? 8787);
const token = env.LUNA_TOKEN;
if (host !== "127.0.0.1" && host !== "localhost" && !token) {
  console.error("refusing to bind non-loopback host without LUNA_TOKEN");
  process.exit(1);
}

const models = createModels();
const which = env.LUNA_PROVIDER ?? "faux";
let model: { provider: string; modelId: string };
if (which === "faux") {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 1000 }, (_, i) => fauxAssistantMessage([fauxText(`faux reply #${i + 1}`)])));
  models.setProvider(faux.provider);
  const m = faux.getModel();
  model = { provider: m.provider, modelId: m.id };
} else {
  models.setProvider(which === "anthropic" ? anthropicProvider() : openaiProvider());
  if (!env.LUNA_MODEL) { console.error("LUNA_MODEL required for provider " + which); process.exit(1); }
  model = { provider: which, modelId: env.LUNA_MODEL };
}

const harness = await openLuna({ dbPath: env.LUNA_DB ?? "luna.db", models, cwd: env.LUNA_CWD });
harness.resume(); // continue any run a previous process left unfinished
const app = createApp({ harness, token, agent: { model } });
const server = serve({ fetch: app.fetch, hostname: host, port }, (i) => console.log(`luna listening on http://${i.address}:${i.port} provider=${which} auth=${token ? "on" : "off"}`));

let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  server.close();
  await harness.close(context).catch(() => {});
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
