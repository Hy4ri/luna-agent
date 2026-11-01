// Projection and truncation for lightweight session history UI responses.
// Keeps durable storage and provider model history untouched.
import type { EntryRecord, AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import type { Message, TextContent, ImageContent } from "@earendil-works/pi-ai";

export const TOOL_RESULT_TRUNCATION_LIMIT = 8 * 1024; // 8 KB
export const TOOL_RESULT_HEAD_BYTES = 2 * 1024; // 2 KB
export const TOOL_RESULT_TAIL_BYTES = 2 * 1024; // 2 KB

export interface TruncatedMeta {
  originalBytes: number;
}

/**
 * Truncate a tool-result text string if its UTF-8 byte length exceeds 8 KB.
 * Returns the sliced head (2 KB) + marker + tail (2 KB) and the original byte length.
 */
export function truncateToolText(text: string): { text: string; truncated?: TruncatedMeta } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= TOOL_RESULT_TRUNCATION_LIMIT) {
    return { text };
  }
  let headEnd = TOOL_RESULT_HEAD_BYTES;
  while ((buf[headEnd]! & 0xc0) === 0x80) headEnd--;
  let tailStart = buf.length - TOOL_RESULT_TAIL_BYTES;
  while ((buf[tailStart]! & 0xc0) === 0x80) tailStart++;
  const head = buf.subarray(0, headEnd).toString("utf8");
  const tail = buf.subarray(tailStart).toString("utf8");
  const marker = `\n\n… [truncated ${tailStart - headEnd} bytes] …\n\n`;
  return {
    text: head + marker + tail,
    truncated: { originalBytes: buf.length },
  };
}

/**
 * Project an entry for the lightweight UI view (?view=ui):
 * 1. Strips system sections: system messages with sections return `sections: {}` and `sectionsOmitted: true`.
 * 2. Truncates toolResult text blocks > 8KB to 2KB head + 2KB tail with a `truncated: { originalBytes }` marker.
 * 3. Drops data that only providers read: system tool-definition changes (`toolsOmitted: true` marks it) and
 *    assistant text/thinking signatures. These were half of a typical history page.
 *
 * Does not mutate the original entry.
 */
export function projectEntryForUi(entry: EntryRecord): EntryRecord {
  if (!entry.model || entry.model.length === 0) {
    return entry;
  }

  let modelChanged = false;
  const projectedModel: Message[] = entry.model.map((msg) => {
    if (msg.role === "system") {
      const sections = !!msg.sections && Object.keys(msg.sections).length > 0;
      const tools = msg.toolsAdded !== undefined || msg.toolsRemoved !== undefined;
      if (!sections && !tools) return msg;
      modelChanged = true;
      const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = msg;
      return {
        ...(tools ? rest : msg),
        ...(sections ? { sections: {}, sectionsOmitted: true } : {}),
        ...(tools ? { toolsOmitted: true } : {}),
      } as Message;
    }

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      let signed = false;
      const content = msg.content.map((block) => {
        const b = block as unknown as Record<string, unknown>;
        if (b.textSignature === undefined && b.thinkingSignature === undefined) return block;
        signed = true;
        const { textSignature: _text, thinkingSignature: _thinking, ...rest } = b;
        return rest as unknown as typeof block;
      });
      if (!signed) return msg;
      modelChanged = true;
      return { ...msg, content };
    }

    if (msg.role === "toolResult") {
      let contentChanged = false;
      const content = msg.content;
      if (Array.isArray(content)) {
        const nextContent = content.map((block) => {
          if (block.type === "text" && typeof block.text === "string") {
            const res = truncateToolText(block.text);
            if (res.truncated) {
              contentChanged = true;
              return {
                ...block,
                text: res.text,
                truncated: res.truncated,
              } as TextContent & { truncated?: TruncatedMeta };
            }
          }
          return block;
        });
        if (contentChanged) {
          modelChanged = true;
          return {
            ...msg,
            content: nextContent as (TextContent | ImageContent)[],
          };
        }
      }
      return msg;
    }

    return msg;
  });

  if (!modelChanged) {
    return entry;
  }

  return {
    ...entry,
    model: projectedModel,
  };
}

export interface ExtractedToolBlock {
  readonly text: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly originalBytes: number;
  readonly truncated: boolean;
}

/**
 * Locate the full toolResult content for an entry.
 * Can match by toolCallId (if provided) or find the first/primary toolResult text block in the entry.
 */
export function extractFullToolResult(
  entry: EntryRecord,
  toolCallId?: string,
): ExtractedToolBlock | undefined {
  if (!entry.model) return undefined;

  for (const msg of entry.model) {
    if (msg.role === "toolResult") {
      if (toolCallId && msg.toolCallId !== toolCallId) {
        continue;
      }
      let fullText = "";
      if (Array.isArray(msg.content)) {
        fullText = msg.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text || "")
          .join("\n");
      }
      const buf = Buffer.from(fullText, "utf8");
      return {
        text: fullText,
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        originalBytes: buf.length,
        truncated: buf.length > TOOL_RESULT_TRUNCATION_LIMIT,
      };
    }
  }

  return undefined;
}

/**
 * Project an AgentEvent for the UI:
 * Applies projectEntryForUi to any entry carried on the event.
 */
export function projectAgentEventForUi(event: AgentEvent): AgentEvent {
  if (!event || typeof event !== "object") return event;
  switch (event.type) {
    case "entry_appended":
      return {
        ...event,
        entry: projectEntryForUi(event.entry),
      };
    case "message_end":
      return {
        ...event,
        entry: projectEntryForUi(event.entry),
      };
    case "tool_execution_end":
      if (event.entry) {
        return {
          ...event,
          entry: projectEntryForUi(event.entry),
        };
      }
      return event;
    case "snapshot": {
      const snap = event as SnapshotEvent;
      return {
        ...snap,
        entries: snap.entries ? snap.entries.map((e) => projectEntryForUi(e)) : snap.entries,
      };
    }
    default:
      return event;
  }
}
