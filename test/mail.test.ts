import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64UrlDecode, base64UrlEncode, buildRawMime, extractGmailParts } from "../src/mail/mime.js";
import { parseGmailThread } from "../src/mail/gmail.js";
import { MailStore } from "../src/mail/store.js";
import { MailService } from "../src/mail/service.js";
import { parseGoogleCredentialsInput } from "../src/mail/auth.js";

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
  test("buildRawMime encodes UTF-8 subjects, strips CRLF injection, and formats multipart/alternative", () => {
    const raw = buildRawMime({
      from: "Luna <luna@example.com>",
      to: "m57@example.com\r\nBcc: evil@example.com",
      subject: "مرحبا Luna 🚀",
      text: "Hello plain",
      html: "<p>Hello <b>HTML</b></p>",
      inReplyTo: "<msg-1@example.com>",
      references: "<msg-0@example.com> <msg-1@example.com>",
    });

    const decoded = base64UrlDecode(raw).toString("utf8");
    assert.ok(decoded.includes("From: Luna <luna@example.com>\r\n"));
    assert.ok(!decoded.includes("\r\nBcc: evil@example.com"));
    assert.ok(decoded.includes("Subject: =?UTF-8?B?"));
    assert.ok(decoded.includes("In-Reply-To: <msg-1@example.com>\r\n"));
    assert.ok(decoded.includes("Content-Type: multipart/alternative;"));
    assert.ok(decoded.includes(Buffer.from("Hello plain", "utf8").toString("base64")));
    assert.ok(decoded.includes(Buffer.from("<p>Hello <b>HTML</b></p>", "utf8").toString("base64")));
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
});
