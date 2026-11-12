import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { MailError, type MailFolder } from "./mail/types.js";
import type { MailModifyAction, MailService } from "./mail/service.js";
import { StringEnum } from "./string-enum.js";

const text = (t: string, isError = false) => ({
  output: [{ type: "text" as const, text: t }],
  ...(isError ? { isError: true } : {}),
});

async function guard(fn: () => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MailError) return text(e.message, true);
    throw e;
  }
}

const FOLDER = StringEnum(["INBOX", "UNREAD", "STARRED", "SENT", "DRAFT", "TRASH", "ALL"]);
const MODIFY_ACTION = StringEnum(["archive", "unarchive", "markRead", "markUnread", "star", "unstar", "trash", "untrash"]);

/** Tools: mail_list, mail_read, mail_search, mail_modify, mail_draft, mail_send. */
export function createMailExtension(get: () => MailService | undefined) {
  const need = () => {
    const m = get();
    if (!m) throw new MailError("Mail subsystem is unavailable", 404);
    return m;
  };

  const list = defineTool({
    name: "mail_list",
    description: "List cached Gmail threads by folder (INBOX, UNREAD, STARRED, SENT, DRAFT, TRASH, ALL) or filter query. Set sync=true to pull latest changes from Gmail first.",
    parameters: Type.Object({
      account: Type.Optional(Type.String({ description: "Connected Gmail address (optional when only one account)" })),
      folder: Type.Optional(FOLDER),
      q: Type.Optional(Type.String({ description: "Local text filter across subject, snippet, participants, and body" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      sync: Type.Optional(Type.Boolean({ description: "Sync with Gmail before listing" })),
    }),
    replay: "safe",
    async execute(a) {
      return guard(async () => {
        const m = need();
        if (a.sync) {
          if (a.account) await m.syncAccount(a.account);
          else await m.syncAll();
        }
        const { threads, total } = m.listThreads({
          accountEmail: a.account,
          folder: (a.folder as MailFolder | undefined) ?? "INBOX",
          q: a.q,
          limit: a.limit ?? 20,
        });
        if (threads.length === 0) return text("No matching email threads.");
        const lines = threads.map((t) => {
          const flags = [t.unread ? "UNREAD" : "", t.starred ? "STARRED" : ""].filter(Boolean).join(",");
          const date = new Date(t.lastMessageAt).toISOString().slice(0, 16).replace("T", " ");
          return `${t.id} | ${date} | ${t.participants.slice(0, 2).join(", ")} | ${t.subject}${flags ? ` [${flags}]` : ""}\n  ${t.snippet}`;
        });
        return text(`Showing ${threads.length} of ${total} threads:\n${lines.join("\n")}`);
      });
    },
  });

  const read = defineTool({
    name: "mail_read",
    description: "Read a full Gmail thread by threadId, including all messages, headers, bodies, and attachment metadata.",
    parameters: Type.Object({
      threadId: Type.String(),
      account: Type.Optional(Type.String()),
    }),
    replay: "safe",
    async execute(a) {
      return guard(async () => {
        const t = await need().getThread(a.threadId, a.account);
        const header = `Thread ${t.id} (${t.accountEmail})\nSubject: ${t.subject}\nLabels: ${t.labelIds.join(", ")}\nMessages: ${t.messages.length}`;
        const msgs = t.messages.map((m, i) => {
          const atts = m.attachments.length
            ? `\nAttachments: ${m.attachments.map((att) => `${att.filename} (${att.mimeType}, ${att.size}B)`).join(", ")}`
            : "";
          return `--- Message ${i + 1} (${m.id}) ---\nFrom: ${m.from}\nTo: ${m.to}${m.cc ? `\nCc: ${m.cc}` : ""}\nDate: ${new Date(m.dateMs).toISOString()}${atts}\n\n${m.bodyText || "(empty body)"}`;
        });
        return text(`${header}\n\n${msgs.join("\n\n")}`);
      });
    },
  });

  const search = defineTool({
    name: "mail_search",
    description: "Search Gmail directly using Gmail query syntax (e.g. 'from:alice is:unread', 'subject:invoice') and cache matching threads.",
    parameters: Type.Object({
      q: Type.String(),
      account: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
    }),
    replay: "safe",
    async execute(a) {
      return guard(async () => {
        const threads = await need().searchRemote({ accountEmail: a.account, q: a.q, maxResults: a.limit ?? 15 });
        if (threads.length === 0) return text(`No Gmail threads matched "${a.q}".`);
        const lines = threads.map((t) => {
          const date = new Date(t.lastMessageAt).toISOString().slice(0, 16).replace("T", " ");
          return `${t.id} | ${date} | ${t.participants.slice(0, 2).join(", ")} | ${t.subject}\n  ${t.snippet}`;
        });
        return text(`Found ${threads.length} threads:\n${lines.join("\n")}`);
      });
    },
  });

  const modify = defineTool({
    name: "mail_modify",
    description: "Modify a Gmail thread's state: archive, unarchive, markRead, markUnread, star, unstar, trash, or untrash.",
    parameters: Type.Object({
      threadId: Type.String(),
      action: MODIFY_ACTION,
      account: Type.Optional(Type.String()),
    }),
    replay: "safe",
    async execute(a) {
      return guard(async () => {
        const updated = await need().modifyThread(a.threadId, a.action as MailModifyAction, a.account);
        return text(`Updated thread ${updated.id} (${a.action}). Labels: ${updated.labelIds.join(", ")}`);
      });
    },
  });

  const draft = defineTool({
    name: "mail_draft",
    description: "Save a Gmail draft without sending it. Use replyToThreadId to draft a reply in an existing thread.",
    parameters: Type.Object({
      to: Type.String(),
      subject: Type.String(),
      text: Type.String(),
      cc: Type.Optional(Type.String()),
      bcc: Type.Optional(Type.String()),
      replyToThreadId: Type.Optional(Type.String()),
      account: Type.Optional(Type.String()),
    }),
    replay: "unsafe",
    async execute(a) {
      return guard(async () => {
        const d = await need().saveDraft({
          accountEmail: a.account,
          to: a.to,
          cc: a.cc,
          bcc: a.bcc,
          subject: a.subject,
          text: a.text,
          replyToThreadId: a.replyToThreadId,
        });
        return text(`Saved draft ${d.draftId} on ${d.accountEmail}.`);
      });
    },
  });

  const send = defineTool({
    name: "mail_send",
    description: "Send an email or reply to an existing Gmail thread. Confirm recipients and content with the user before sending.",
    parameters: Type.Object({
      to: Type.String(),
      subject: Type.String(),
      text: Type.String(),
      cc: Type.Optional(Type.String()),
      bcc: Type.Optional(Type.String()),
      replyToThreadId: Type.Optional(Type.String()),
      account: Type.Optional(Type.String()),
    }),
    replay: "unsafe",
    async execute(a) {
      return guard(async () => {
        const s = await need().sendMessage({
          accountEmail: a.account,
          to: a.to,
          cc: a.cc,
          bcc: a.bcc,
          subject: a.subject,
          text: a.text,
          replyToThreadId: a.replyToThreadId,
        });
        return text(`Sent message ${s.id} in thread ${s.threadId} from ${s.accountEmail}.`);
      });
    },
  });

  return defineExtension({
    name: "mail",
    tools: [list, read, search, modify, draft, send],
  });
}
