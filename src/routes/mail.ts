import type { Hono } from "hono";
import type { RouteCtx } from "./context.js";
import { MailError, type MailFolder } from "../mail/types.js";
import type { MailModifyAction, MailService } from "../mail/service.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Public OAuth2 callback: GET /oauth/gmail/callback. Protected by single-use cryptographic `state` + PKCE. */
export function registerMailOAuthCallback(app: Hono, mail: MailService | undefined): void {
  app.get("/oauth/gmail/callback", async (c) => {
    if (!mail) return c.html("<h1>Mail is disabled</h1>", 404);
    const error = c.req.query("error");
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";

    if (error) {
      return c.html(callbackHtml({ ok: false, message: `Google OAuth error: ${error}` }), 400);
    }
    if (!code || !state) {
      return c.html(callbackHtml({ ok: false, message: "Missing code or state parameter" }), 400);
    }

    try {
      const account = await mail.finishOAuth(code, state);
      return c.html(callbackHtml({ ok: true, email: account.email, message: `Connected ${account.email}` }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = e instanceof MailError ? e.status : 500;
      return c.html(callbackHtml({ ok: false, message: msg }), status);
    }
  });
}

function callbackHtml(res: { ok: boolean; email?: string; message: string }): string {
  const payload = JSON.stringify({ type: "luna-mail-oauth", ok: res.ok, email: res.email ?? null, message: res.message });
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Luna Mail OAuth</title>
<style>
  body { background: #121212; color: #ececec; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #1c1c1c; border: 1px solid #2c2c2c; border-radius: 2px; padding: 24px; max-width: 420px; text-align: center; }
  .ok { color: #8fd3a5; }
  .err { color: #f87171; }
  a { color: #e86060; text-decoration: none; }
</style>
</head>
<body>
  <div class="card">
    <h2 class="${res.ok ? "ok" : "err"}">${res.ok ? "Gmail Connected" : "Connection Failed"}</h2>
    <p>${escapeHtml(res.message)}</p>
    <p><a href="/#mail">Return to Luna Mail</a></p>
  </div>
  <script>
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(${payload}, "*");
        setTimeout(() => window.close(), 600);
      } else if (${res.ok ? "true" : "false"}) {
        setTimeout(() => { location.href = "/#mail"; }, 800);
      }
    } catch {}
  </script>
</body>
</html>`;
}

const VALID_FOLDERS = new Set<MailFolder>(["INBOX", "UNREAD", "STARRED", "SENT", "DRAFT", "TRASH", "ALL"]);
const VALID_ACTIONS = new Set<MailModifyAction>(["archive", "unarchive", "markRead", "markUnread", "star", "unstar", "trash", "untrash"]);

export function registerMail(app: Hono, ctx: RouteCtx): void {
  const { opts, err } = ctx;
  const need = () => {
    if (!opts.mail) throw new MailError("Mail subsystem is disabled", 404);
    return opts.mail;
  };

  app.use("/v1/mail/*", async (c, next) => {
    if (!opts.mail) return err(c, 404, "mail disabled");
    await next();
  });

  app.get("/v1/mail/status", (c) => {
    return c.json(need().status());
  });

  app.post("/v1/mail/oauth/config", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b !== "object") return err(c, 400, "body must be a JSON object");
    need().configureOAuth({
      clientId: typeof b.clientId === "string" ? b.clientId : undefined,
      clientSecret: typeof b.clientSecret === "string" ? b.clientSecret : undefined,
      credentialsJson: typeof b.credentialsJson === "string" ? b.credentialsJson : undefined,
    });
    return c.json(need().status());
  });

  app.post("/v1/mail/oauth/start", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const reqOrigin = typeof b.origin === "string" && /^https?:\/\//i.test(b.origin)
      ? b.origin.replace(/\/+$/, "")
      : new URL(c.req.url).origin;
    const redirectUri = `${reqOrigin}/oauth/gmail/callback`;
    return c.json(need().startOAuth(redirectUri));
  });

  app.delete("/v1/mail/accounts/:email", (c) => {
    const email = decodeURIComponent(c.req.param("email"));
    const removed = need().removeAccount(email);
    return removed ? c.json({ ok: true }) : err(c, 404, "account not found");
  });

  app.post("/v1/mail/sync", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const full = b.full === true;
    const accountEmail = typeof b.accountEmail === "string" && b.accountEmail.trim() ? b.accountEmail.trim() : undefined;
    const mail = need();
    if (accountEmail) {
      const result = await mail.syncAccount(accountEmail, { full });
      return c.json({ results: [result], status: mail.status() });
    }
    const results = await mail.syncAll({ full });
    return c.json({ results, status: mail.status() });
  });

  app.get("/v1/mail/threads", async (c) => {
    const mail = need();
    const accountEmail = c.req.query("accountEmail") || undefined;
    const folderRaw = (c.req.query("folder") || "INBOX").toUpperCase() as MailFolder;
    const folder: MailFolder = VALID_FOLDERS.has(folderRaw) ? folderRaw : "INBOX";
    const q = c.req.query("q") || undefined;
    const limit = Number(c.req.query("limit") || 50);
    const offset = Number(c.req.query("offset") || 0);
    const remote = c.req.query("remote") === "1";

    if (remote && q?.trim()) {
      await mail.searchRemote({ accountEmail, q: q.trim(), maxResults: Math.min(50, limit || 25) });
    }

    return c.json(mail.listThreads({
      accountEmail,
      folder,
      q,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    }));
  });

  app.get("/v1/mail/threads/:id", async (c) => {
    const accountEmail = c.req.query("accountEmail") || undefined;
    const thread = await need().getThread(c.req.param("id"), accountEmail);
    return c.json(thread);
  });

  app.get("/v1/mail/attachments/:messageId/:attachmentId", async (c) => {
    const accountEmail = c.req.query("accountEmail");
    if (!accountEmail) return err(c, 400, "accountEmail query param is required");
    const buf = await need().getAttachment(accountEmail, c.req.param("messageId"), c.req.param("attachmentId"));
    const mime = c.req.query("mimeType") || "application/octet-stream";
    const filename = (c.req.query("filename") || "attachment").replace(/["\r\n]/g, "_");
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": mime,
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  });

  app.post("/v1/mail/threads/:id/modify", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const action = b?.action as MailModifyAction;
    if (!VALID_ACTIONS.has(action)) return err(c, 400, "invalid modify action");
    const accountEmail = typeof b?.accountEmail === "string" ? b.accountEmail : undefined;
    const updated = await need().modifyThread(c.req.param("id"), action, accountEmail);
    return c.json(updated);
  });

  app.post("/v1/mail/send", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b.to !== "string" || !b.to.trim()) return err(c, 400, "to is required");
    if (typeof b.text !== "string") return err(c, 400, "text is required");
    const sent = await need().sendMessage({
      accountEmail: typeof b.accountEmail === "string" ? b.accountEmail : undefined,
      to: b.to,
      cc: typeof b.cc === "string" ? b.cc : undefined,
      bcc: typeof b.bcc === "string" ? b.bcc : undefined,
      subject: typeof b.subject === "string" ? b.subject : "",
      text: b.text,
      html: typeof b.html === "string" ? b.html : undefined,
      replyToThreadId: typeof b.replyToThreadId === "string" ? b.replyToThreadId : undefined,
    });
    return c.json(sent, 201);
  });

  app.post("/v1/mail/drafts", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b.to !== "string") return err(c, 400, "to is required");
    if (typeof b.text !== "string") return err(c, 400, "text is required");
    const draft = await need().saveDraft({
      accountEmail: typeof b.accountEmail === "string" ? b.accountEmail : undefined,
      to: b.to,
      cc: typeof b.cc === "string" ? b.cc : undefined,
      bcc: typeof b.bcc === "string" ? b.bcc : undefined,
      subject: typeof b.subject === "string" ? b.subject : "",
      text: b.text,
      html: typeof b.html === "string" ? b.html : undefined,
      replyToThreadId: typeof b.replyToThreadId === "string" ? b.replyToThreadId : undefined,
    });
    return c.json(draft, 201);
  });
}
