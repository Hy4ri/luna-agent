import type { MailAttachment } from "./types.js";

export function base64UrlEncode(input: string | Uint8Array): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, "base64");
}

export function decodeBase64UrlText(input: string | undefined): string {
  if (!input) return "";
  try {
    return base64UrlDecode(input).toString("utf8");
  } catch {
    return "";
  }
}

export interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: {
    attachmentId?: string;
    size?: number;
    data?: string;
  };
  parts?: GmailMessagePart[];
}

export function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name?.toLowerCase() === lower) return h.value ?? "";
  }
  return "";
}

export function extractParticipantName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  if (match && match[1]?.trim()) return match[1].trim();
  const angle = trimmed.match(/<([^>]+)>/);
  if (angle && angle[1]) return angle[1];
  return trimmed;
}

export function splitAddressList(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  let angleDepth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "\\" && inQuotes && i + 1 < raw.length) {
      cur += ch + raw[i + 1]!;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
      continue;
    }
    if (!inQuotes) {
      if (ch === "<") angleDepth++;
      else if (ch === ">" && angleDepth > 0) angleDepth--;
      else if (ch === "," && angleDepth === 0) {
        if (cur.trim()) out.push(cur.trim());
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseParticipants(fromHeader: string, toHeader: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [fromHeader, toHeader]) {
    if (!raw) continue;
    for (const part of splitAddressList(raw)) {
      const name = extractParticipantName(part);
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        out.push(name);
      }
    }
  }
  return out;
}

export function stripHtmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractGmailParts(payload: GmailMessagePart | undefined): {
  bodyText: string;
  bodyHtml: string;
  attachments: MailAttachment[];
} {
  const textParts: string[] = [];
  const htmlParts: string[] = [];
  const attachments: MailAttachment[] = [];

  function walk(part: GmailMessagePart | undefined) {
    if (!part) return;
    const mime = (part.mimeType ?? "").toLowerCase();
    const filename = (part.filename ?? "").trim();
    const disposition = headerValue(part.headers, "Content-Disposition").toLowerCase();
    const contentId = headerValue(part.headers, "Content-ID").replace(/^<|>$/g, "").trim() || undefined;
    const isAttachment = Boolean(part.body?.attachmentId) || Boolean(filename && (disposition.includes("attachment") || !mime.startsWith("text/")));

    if (isAttachment && part.body?.attachmentId) {
      attachments.push({
        attachmentId: part.body.attachmentId,
        filename: filename || `attachment-${attachments.length + 1}`,
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body.size ?? 0,
        contentId,
        inline: disposition.includes("inline") || Boolean(contentId),
      });
    } else if (mime === "text/plain" && part.body?.data) {
      textParts.push(decodeBase64UrlText(part.body.data));
    } else if (mime === "text/html" && part.body?.data) {
      htmlParts.push(decodeBase64UrlText(part.body.data));
    }

    if (part.parts) {
      for (const child of part.parts) walk(child);
    }
  }

  walk(payload);

  const bodyHtml = htmlParts.join("\n").trim();
  const bodyText = textParts.join("\n").trim() || (bodyHtml ? stripHtmlToText(bodyHtml) : "");
  return { bodyText, bodyHtml, attachments };
}

function encodeHeaderWord(value: string): string {
  // Strip CR/LF to prevent header injection.
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function cleanAddressHeader(value: string): string {
  return splitAddressList(value.replace(/[\r\n]+/g, " ").trim())
    .map((part) => {
      const m = part.match(/^(.*?)\s*<([^>]+)>$/);
      if (!m) return part;
      const rawName = m[1]!.trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim();
      const addr = m[2]!.trim();
      if (!rawName) return `<${addr}>`;
      if (/^[\x20-\x7E]*$/.test(rawName)) {
        const quoted = /[",;<>()[\]\\:@]/.test(rawName) ? `"${rawName.replace(/"/g, '\\"')}"` : rawName;
        return `${quoted} <${addr}>`;
      }
      return `${encodeHeaderWord(rawName)} <${addr}>`;
    })
    .join(", ");
}

function wrapBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

export interface BuildRawMimeInput {
  from?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
}

export function buildRawMime(input: BuildRawMimeInput): string {
  const headers: string[] = [
    "MIME-Version: 1.0",
  ];
  if (input.from?.trim()) headers.push(`From: ${cleanAddressHeader(input.from)}`);
  headers.push(`To: ${cleanAddressHeader(input.to)}`);
  if (input.cc?.trim()) headers.push(`Cc: ${cleanAddressHeader(input.cc)}`);
  if (input.bcc?.trim()) headers.push(`Bcc: ${cleanAddressHeader(input.bcc)}`);
  headers.push(`Subject: ${encodeHeaderWord(input.subject || "(no subject)")}`);
  if (input.inReplyTo?.trim()) headers.push(`In-Reply-To: ${input.inReplyTo.replace(/[\r\n]+/g, " ").trim()}`);
  if (input.references?.trim()) headers.push(`References: ${input.references.replace(/[\r\n]+/g, " ").trim()}`);

  if (input.html?.trim()) {
    const boundary = `luna_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const parts = [
      `--${boundary}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      "",
      wrapBase64(Buffer.from(input.text, "utf8").toString("base64")),
      `--${boundary}`,
      `Content-Type: text/html; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      "",
      wrapBase64(Buffer.from(input.html, "utf8").toString("base64")),
      `--${boundary}--`,
      "",
    ];
    return base64UrlEncode(`${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`);
  }

  headers.push(`Content-Type: text/plain; charset="UTF-8"`);
  headers.push(`Content-Transfer-Encoding: base64`);
  const body = wrapBase64(Buffer.from(input.text, "utf8").toString("base64"));
  return base64UrlEncode(`${headers.join("\r\n")}\r\n\r\n${body}`);
}
