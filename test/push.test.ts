import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { DeviceStore, FcmSender } from "../src/push.js";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const account = { project_id: "proj", client_email: "sa@proj.iam", private_key: key };

test("device store persists, dedupes and removes tokens", () => {
  const file = join(mkdtempSync(join(tmpdir(), "push-")), "d.json");
  const d = new DeviceStore(file);
  d.add("a".repeat(30)); d.add("a".repeat(30));
  assert.equal(new DeviceStore(file).list().length, 1);
  d.remove("a".repeat(30));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).tokens, []);
});

test("FCM sender signs a JWT, posts one message per device and drops unregistered tokens", async () => {
  const d = new DeviceStore(join(mkdtempSync(join(tmpdir(), "push-")), "d.json"));
  const good = "g".repeat(30), dead = "d".repeat(30);
  d.add(good); d.add(dead);
  const calls: { url: string; body: any }[] = [];
  const fake = (async (url: string, init: any) => {
    if (url.includes("oauth2")) {
      const jwt = new URLSearchParams(String(init.body)).get("assertion")!.split(".");
      assert.equal(JSON.parse(Buffer.from(jwt[1]!, "base64url").toString()).scope, "https://www.googleapis.com/auth/firebase.messaging");
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    }
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    assert.equal(init.headers.Authorization, "Bearer tok");
    return body.message.token === dead ? new Response('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}', { status: 404 }) : new Response("{}");
  }) as unknown as typeof fetch;
  await new FcmSender(account, d, fake).send({ title: "T", body: "B", sessionId: "7", status: "finished" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "https://fcm.googleapis.com/v1/projects/proj/messages:send");
  assert.equal(calls[0]!.body.message.data.sessionId, "7");
  assert.deepEqual(d.list(), [good]);
});
