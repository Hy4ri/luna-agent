// Message send times: stamp each user message with its stored timestamp, for the model request only.
// Stored timestamps never change, so old messages render identically on every request and the prompt cache holds.
// Research basis: per-message timestamps double time-rule catch rates over a system-prompt clock (arXiv 2611.06839).
import type { Message } from "@earendil-works/pi-ai";
import { GenerationTask, defineExtension, hook, section } from "@earendil-works/pi-durable";

const pad = (n: number) => String(n).padStart(2, "0");

/** `[2026-11-07 01:55 +03]` in host local time. */
export function formatStamp(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? "+" : "-", a = Math.abs(off);
  const tz = `${sign}${pad(Math.floor(a / 60))}${a % 60 ? pad(a % 60) : ""}`;
  return `[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${tz}]`;
}

/** Prefix every user message that has a valid timestamp. Returns the same array when nothing changes. */
export function stampMessages(messages: readonly Message[]): readonly Message[] {
  let changed = false;
  const out = messages.map((m) => {
    if (m.role !== "user" || !Number.isFinite(m.timestamp) || m.timestamp <= 0) return m;
    const stamp = formatStamp(m.timestamp) + " ";
    if (typeof m.content === "string") { changed = true; return { ...m, content: stamp + m.content }; }
    if (!Array.isArray(m.content)) return m;
    changed = true;
    const i = m.content.findIndex((p) => p.type === "text");
    const content = i < 0
      ? [{ type: "text" as const, text: stamp.trimEnd() }, ...m.content]
      : m.content.map((p, j) => (j === i && p.type === "text" ? { ...p, text: stamp + p.text } : p));
    return { ...m, content };
  });
  return changed ? out : messages;
}

export const MessageTimeExtension = defineExtension({
  name: "message-time",
  sections: [section("message-time", () =>
    "Each user message starts with its real send time in the host's local time, e.g. [2026-11-07 01:55 +03]. " +
    "Use these stamps to judge elapsed time: after a long gap, re-check state that may have changed (CI, processes, quotas, prices) before relying on earlier results. " +
    "The stamps are added by the runtime; do not write them in your replies.")],
  hooks: [hook(GenerationTask, {
    async beforeRequest(request) {
      const messages = stampMessages(request.messages);
      return messages === request.messages ? undefined : { messages };
    },
  })],
});
