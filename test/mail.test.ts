import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { base64UrlDecode, base64UrlEncode, buildRawMime, extractGmailParts, parseParticipants, splitAddressList } from "../src/mail/mime.js";
import { parseGmailThread } from "../src/mail/gmail.js";
import { MailStore } from "../src/mail/store.js";
import { MailService } from "../src/mail/service.js";
import { parseGoogleCredentialsInput } from "../src/mail/auth.js";
import { registerMailOAuthCallback } from "../src/routes/mail.js";
import { createMailExtension } from "../src/mail-tools.js";
import { ConfigSchema } from "../src/config.js";
import { createApp } from "../src/server.js";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { context, openLuna } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";

const tempDirs: string[] = [];
const stores: MailStore[] = [];
const services: MailService[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "luna-mail-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (services.length) services.pop()!.close();
  while (stores.length) stores.pop()!.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("mail mime", () => {
  test("buildRawMime encodes UTF-8 subjects and display names, wraps base64 lines, and splits quoted commas", () => {
    const raw = buildRawMime({
      from: '"لونا, AI" <luna@example.com>',
      to: '"Doe, John" <john@example.com>, alice@example.com\r\nBcc: evil@example.com',
      subject: "مرحبا Luna 🚀",
      text: "Hello plain ".repeat(20),
      html: "<p>Hello <b>HTML</b></p>",
      inReplyTo: "<msg-1@example.com>",
      references: "<msg-0@example.com> <msg-1@example.com>",
    });

    const decoded = base64UrlDecode(raw).toString("utf8");
    assert.ok(decoded.includes("From: =?UTF-8?B?"));
    assert.ok(!decoded.includes("\r\nBcc: evil@example.com"));
    assert.ok(decoded.includes('To: "Doe, John" <john@example.com>'));
    assert.ok(decoded.includes("Subject: =?UTF-8?B?"));
    assert.ok(decoded.includes("In-Reply-To: <msg-1@example.com>\r\n"));
    assert.ok(decoded.includes("Content-Type: multipart/alternative;"));
    for (const line of decoded.split("\r\n")) {
      assert.ok(line.length <= 998, `MIME line exceeded 998 chars: ${line.length}`);
    }

    assert.deepEqual(splitAddressList('"Doe, John" <john@example.com>, Bob <bob@example.com>'), [
      '"Doe, John" <john@example.com>',
      "Bob <bob@example.com>",
    ]);
    assert.deepEqual(parseParticipants('"Doe, John" <john@example.com>', "Bob <bob@example.com>"), [
      "Doe, John",
      "Bob",
    ]);
  });

  test("extractGmailParts extracts text, html, and attachments from nested multipart payload", () => {
    const parts = extractGmailParts({
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: base64UrlEncode("Plain body") } },
            { mimeType: "text/html", body: { data: base64UrlEncode("<p>HTML body</p>") } },
          ],
        },
        {
          mimeType: "application/pdf",
          filename: "invoice.pdf",
          headers: [{ name: "Content-Disposition", value: 'attachment; filename="invoice.pdf"' }],
          body: { attachmentId: "att-123", size: 4096 },
        },
      ],
    });

    assert.equal(parts.bodyText, "Plain body");
    assert.equal(parts.bodyHtml, "<p>HTML body</p>");
    assert.equal(parts.attachments.length, 1);
    assert.equal(parts.attachments[0]!.filename, "invoice.pdf");
    assert.equal(parts.attachments[0]!.attachmentId, "att-123");
    assert.equal(parts.attachments[0]!.size, 4096);
  });
});

describe("mail store & parser", () => {
  test("MailStore persists threads, filters folders/queries, mutates labels, and cascades on account removal", () => {
    const dir = makeTempDir();
    const store = new MailStore(dir);
    stores.push(store);

    store.upsertAccount("luna@gmail.com", "Luna");

    const parsed = parseGmailThread("luna@gmail.com", {
      id: "thr-1",
      historyId: "100",
      messages: [
        {
          id: "msg-1",
          threadId: "thr-1",
          labelIds: ["INBOX", "UNREAD"],
          snippet: "Quarterly report attached",
          internalDate: "1700000000000",
          payload: {
            headers: [
              { name: "From", value: "Alice <alice@example.com>" },
              { name: "To", value: "luna@gmail.com" },
              { name: "Subject", value: "Q4 Report" },
              { name: "Message-ID", value: "<m1@example.com>" },
            ],
            mimeType: "text/html",
            body: { data: base64UrlEncode("<div>Please review Q4 numbers.</div>") },
          },
        },
      ],
    });

    store.upsertThread(parsed.summary, parsed.messages);
    assert.equal(store.unreadCount("luna@gmail.com"), 1);

    const inbox = store.listThreads({ folder: "INBOX" });
    assert.equal(inbox.total, 1);
    assert.equal(inbox.threads[0]!.subject, "Q4 Report");

    const search = store.listThreads({ folder: "ALL", q: "numbers" });
    assert.equal(search.total, 1);

    const detail = store.getThread("luna@gmail.com", "thr-1");
    assert.ok(detail);
    assert.equal(detail.messages[0]!.bodyText, "Please review Q4 numbers.");

    // Mark read & archive
    store.applyLabelMutation("luna@gmail.com", "thr-1", [], ["UNREAD", "INBOX"]);
    assert.equal(store.unreadCount("luna@gmail.com"), 0);
    assert.equal(store.listThreads({ folder: "INBOX" }).total, 0);
    assert.equal(store.listThreads({ folder: "ALL" }).total, 1);

    // Cascade delete
    store.removeAccount("luna@gmail.com");
    assert.equal(store.listThreads({ folder: "ALL" }).total, 0);
  });

  test("parseGoogleCredentialsInput supports installed/web credentials.json and rejects invalid input", () => {
    const parsed = parseGoogleCredentialsInput({
      credentialsJson: JSON.stringify({
        web: { client_id: "cid-123", client_secret: "sec-456" },
      }),
    });
    assert.deepEqual(parsed, { clientId: "cid-123", clientSecret: "sec-456" });

    assert.throws(() => parseGoogleCredentialsInput({ clientId: "only-id" }), /required/);
    assert.throws(() => parseGoogleCredentialsInput({ credentialsJson: "{bad" }), /valid JSON/);
  });

  test("MailService configures OAuth without leaking secrets in status()", () => {
    const dir = makeTempDir();
    const svc = new MailService({ dataDir: dir });
    services.push(svc);

    assert.equal(svc.status().oauthConfigured, false);
    svc.configureOAuth({ clientId: "cid", clientSecret: "super-secret-value" });
    const status = svc.status();
    assert.equal(status.oauthConfigured, true);
    assert.ok(!JSON.stringify(status).includes("super-secret-value"));
  });

  test("OAuth callback escapes </script>, uses origin-targeted postMessage with luna:mail-oauth, and respects extension toggle", async () => {
    const dir = makeTempDir();
    const svc = new MailService({ dataDir: dir });
    services.push(svc);

    const app = new Hono();
    let enabled = true;
    registerMailOAuthCallback(app, svc, () => enabled);

    const res = await app.request("/oauth/gmail/callback?error=%3C%2Fscript%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.ok(!html.includes("</script><script>alert(1)</script>"));
    assert.ok(html.includes("luna:mail-oauth"));
    assert.ok(html.includes("window.location.origin"));
    assert.ok(!html.includes('postMessage(payload, "*")'));

    enabled = false;
    const disabledRes = await app.request("/oauth/gmail/callback?error=access_denied");
    assert.equal(disabledRes.status, 404);
  });

  test("Attachment route sets RFC 5987 filename*=UTF-8'' for non-ASCII filenames and respects disabled mail", async () => {
    const dir = makeTempDir();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, memory: false, coding: false });
    const conversations = new ConversationStore(harness);
    const svc = new MailService({
      dataDir: dir,
      fetch: (async () => new Response(JSON.stringify({ data: base64UrlEncode("file-bytes") }), { status: 200 })) as unknown as typeof fetch,
    });
    services.push(svc);
    (svc.auth as unknown as { data: { accounts: Record<string, unknown> } }).data.accounts["luna@gmail.com"] = {
      email: "luna@gmail.com",
      displayName: "Luna",
      refreshToken: "r",
      accessToken: "a",
      expiresAt: Date.now() + 3_600_000,
      addedAt: 1,
    };

    try {
      const settings = {
        shared: () => ConfigSchema.parse({ extensions: ["mail"] }),
      } as never;
      const app = createApp({ harness, conversations, models, mail: svc, settings, cwd: dir, agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } } });

      const attRes = await app.request("/v1/mail/attachments/msg1/att1?accountEmail=luna@gmail.com&filename=%D8%AA%D9%82%D8%B1%D9%8A%D8%B1.pdf&mimeType=application/pdf");
      assert.equal(attRes.status, 200);
      const cd = attRes.headers.get("content-disposition") ?? "";
      assert.ok(cd.includes("filename*=UTF-8''"));
      assert.ok(/^[\x20-\x7E]+$/.test(cd));
    } finally {
      await harness.close(context).catch(() => {});
    }
  });

  test("saveDraft includes reply headers (In-Reply-To, References, Re: subject) for thread replies", async () => {
    const dir = makeTempDir();
    let postedBody: Record<string, unknown> | undefined;
    const svc = new MailService({
      dataDir: dir,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          postedBody = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ id: "draft-1", message: { id: "m-d1", threadId: "thr-1" } }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    services.push(svc);
    (svc.auth as unknown as { data: { accounts: Record<string, unknown> } }).data.accounts["luna@gmail.com"] = {
      email: "luna@gmail.com",
      displayName: "لونا",
      refreshToken: "r",
      accessToken: "a",
      expiresAt: Date.now() + 3_600_000,
      addedAt: 1,
    };
    svc.store.upsertAccount("luna@gmail.com", "لونا");
    const parsed = parseGmailThread("luna@gmail.com", {
      id: "thr-1",
      messages: [{
        id: "msg-1",
        threadId: "thr-1",
        labelIds: ["INBOX"],
        internalDate: "1700000000000",
        payload: {
          headers: [
            { name: "From", value: "Alice <alice@example.com>" },
            { name: "To", value: "luna@gmail.com" },
            { name: "Subject", value: "Hello" },
            { name: "Message-ID", value: "<m1@example.com>" },
            { name: "References", value: "<m0@example.com>" },
          ],
          mimeType: "text/plain",
          body: { data: base64UrlEncode("Hi") },
        },
      }],
    });
    svc.store.upsertThread(parsed.summary, parsed.messages);

    const draft = await svc.saveDraft({
      accountEmail: "luna@gmail.com",
      to: "alice@example.com",
      subject: "",
      text: "Draft reply",
      replyToThreadId: "thr-1",
    });
    assert.equal(draft.draftId, "draft-1");
    assert.equal(postedBody?.message && (postedBody.message as { threadId?: string }).threadId, "thr-1");
    const rawMime = base64UrlDecode(String((postedBody?.message as { raw?: string })?.raw ?? "")).toString("utf8");
    assert.ok(rawMime.includes("Subject: Re: Hello\r\n"));
    assert.ok(rawMime.includes("In-Reply-To: <m1@example.com>\r\n"));
    assert.ok(rawMime.includes("References: <m0@example.com> <m1@example.com>\r\n"));
    assert.ok(rawMime.includes("From: =?UTF-8?B?"));
  });

  test("mail_read truncates oversized threads and wraps output as untrusted content", async () => {
    const dir = makeTempDir();
    const svc = new MailService({ dataDir: dir });
    services.push(svc);
    svc.store.upsertAccount("luna@gmail.com", "Luna");
    const longBody = "X".repeat(20_000);
    const parsed = parseGmailThread("luna@gmail.com", {
      id: "thr-big",
      messages: [{
        id: "msg-big",
        threadId: "thr-big",
        labelIds: ["INBOX"],
        internalDate: "1700000000000",
        payload: {
          headers: [
            { name: "From", value: "Newsletter <news@example.com>" },
            { name: "To", value: "luna@gmail.com" },
            { name: "Subject", value: "Big Newsletter" },
          ],
          mimeType: "text/plain",
          body: { data: base64UrlEncode(longBody) },
        },
      }],
    });
    svc.store.upsertThread(parsed.summary, parsed.messages);

    const ext = createMailExtension(() => svc);
    const readTool = ext.tools!.find((t) => t.name === "mail_read")! as {
      execute: (args: { threadId: string; account?: string; maxChars?: number }, api: never, ctx: never) => Promise<{ output: { type: string; text: string }[] }>;
    };
    const result = await readTool.execute({ threadId: "thr-big" }, {} as never, {} as never);
    const out = result.output[0]!.text;
    assert.ok(out.includes("<<<UNTRUSTED_EMAIL_CONTENT"));
    assert.ok(out.includes("<<<END_UNTRUSTED_EMAIL_CONTENT>>>"));
    assert.ok(out.length < 13_000);
    assert.ok(out.includes("truncated"));
  });
});
