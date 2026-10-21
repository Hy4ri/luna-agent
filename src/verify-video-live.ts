// Explicit opt-in only. This sends video bytes to a real provider and can incur charges.
import assert from "node:assert/strict";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { loadConfig } from "./config.js";
import { BUILTIN_PROVIDERS, customProvider, FileCredentialStore } from "./providers.js";
import { analyzeVideo, resolveVideoClient } from "./video.js";

if (process.env.LUNA_VIDEO_LIVE_APPROVED !== "1") throw new Error("Set LUNA_VIDEO_LIVE_APPROVED=1 only after approval for a real provider request.");
const [source, question, expected] = process.argv.slice(2);
if (!source || !question || !expected) throw new Error("Usage: verify-video-live.ts <video-path-or-url> <question> <expected-answer-regex>");
const cfg = loadConfig();
const models = createModels({ credentials: new FileCredentialStore(join(cfg.dataDir, "auth.json")) });
for (const make of BUILTIN_PROVIDERS) models.setProvider(make());
for (const def of cfg.providers) models.setProvider(customProvider(def));
const active = { provider: cfg.provider, modelId: cfg.model ?? "" };
const model = await resolveVideoClient(models, cfg, active);
assert.ok(model, "No authenticated auxiliary vision model resolves");
console.log(`VIDEO_LIVE_MODEL ${model.provider}/${model.id}`);
const result = await analyzeVideo({ models, config: cfg, active, source, question, cwd: cfg.cwd,
  signal: AbortSignal.timeout(Math.max(cfg.video.timeout_ms, 180_000) + 10_000) });
assert.equal(result.success, true, result.analysis);
assert.match(result.analysis, new RegExp(expected, "i"));
console.log(result.analysis);
console.log("VIDEO_LIVE_OK");
