import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
import { context } from "./luna.js";
import { sideMedia, readSideMedia } from "./side-media.js";

const dir = mkdtempSync(join(tmpdir(), "luna-side-delivery-"));
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
const configPath = join(dir, "config.json");
writeFileSync(configPath, JSON.stringify({ dataDir: dir, cwd: dir, extensions: [], provider: "faux" }));
const cfg = { ...parseConfig(JSON.parse(readFileSync(configPath, "utf8")), dir, {}), configPath };
const rt = await startRuntime(cfg, { models, model, log: () => {} });
const app = createApp({ harness: rt.harness, models, sideCommands: rt.sideCommands, token: "test", agent: { model } });
const request = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { authorization: "Bearer test", "content-type": "application/json", ...(init.headers as object) } });
try {
  assert.deepEqual(cfg.auxiliary, {});
  assert.throws(() => parseConfig({ auxiliary: { side_question: { provider: "faux" } } }, dir, {}));
  assert.throws(() => parseConfig({ auxiliary: { side_question: { provider: "faux", model: fm.id, extra: true } } }, dir, {}));
  assert.equal(parseConfig({ auxiliary: { side_question: { provider: "faux", model: fm.id } } }, dir, {}).auxiliary.side_question?.model, fm.id);
  const revision = rt.settings!.revision();
  const edited = rt.settings!.read(); edited.auxiliary = { side_question: { provider: "faux", model: fm.id } };
  rt.settings!.replace(edited, revision);
  assert.equal(rt.settings!.restartRequired, false, "side route applies without restart");
  assert.equal(rt.settings!.resolved({}).auxiliary.side_question?.model, fm.id);

  const bytes = Buffer.from("test-image"), image = join(dir, "sample image.png");
  writeFileSync(image, bytes);
  writeFileSync(join(dir, "voice.ogg"), "voice");
  const parsed = sideMedia('Before MEDIA:"sample image.png" middle MEDIA:voice.ogg after', dir);
  assert.equal(parsed[0]?.path, image); assert.equal(parsed[0]?.type, "image");
  assert.equal(parsed[1]?.type, "voice"); assert.equal(parsed[1]?.mimeType, "audio/ogg");
  assert.deepEqual(Buffer.from(await readSideMedia(image)), bytes);
  symlinkSync(image, join(dir, "link.png"));
  await assert.rejects(readSideMedia(join(dir, "link.png")));
  await assert.rejects(readSideMedia(dir));

  const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, cwd: dir } }, context);
  const other = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
  faux.setResponses([fauxAssistantMessage('Before MEDIA:"sample image.png" after\nMEDIA:voice.ogg')]);
  const sent = await request(`/v1/sessions/${conv.id}/messages?async=1`, { method: "POST", body: JSON.stringify({ content: "/bg create media", requestId: "media-task" }) });
  assert.equal(sent.status, 202);
  const receipt = await sent.json() as any;
  const deadline = Date.now() + 10000;
  let job: any;
  while (Date.now() < deadline) {
    const response = await request(`/v1/sessions/${conv.id}/side-jobs`);
    job = ((await response.json()) as any).jobs.find((row: any) => row.id === receipt.job.id);
    if (job?.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.status, "complete", job.text);
  assert.equal(job.media.length, 2);
  assert.equal(job.media[0].directive, 'MEDIA:"sample image.png"');
  assert.equal(job.media[0].name, "sample image.png");
  assert.ok(!("path" in job.media[0]), "do not add filesystem paths to metadata");
  const response = await request(job.media[0].url);
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal((await app.request(job.media[0].url)).status, 401);
  assert.equal((await request(job.media[0].url.replace(`/sessions/${conv.id}/`, `/sessions/${other.id}/`))).status, 404);
  assert.equal((await request(job.media[0].url.replace(/\/0$/, "/99"))).status, 404);
  assert.equal((await request(job.media[1].url)).headers.get("content-type"), "audio/ogg");
  assert.equal((await conv.context(context)).messages.filter(m => m.role !== "system").length, 0);
  console.log("SIDE_DELIVERY_OK: live route config, authenticated job-scoped media, file checks, no source transcript writes");
} finally { await rt.close(); rmSync(dir, { recursive: true, force: true }); }
