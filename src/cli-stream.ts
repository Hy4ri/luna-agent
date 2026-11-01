import type { AssistantMessage, AssistantMessageEventStream, TextContent, ThinkingContent } from "@earendil-works/pi-ai";

export interface StreamDeltas {
  textDelta: (delta: string) => void;
  thinkingDelta: (delta: string) => void;
  getText: () => TextContent | undefined;
  getThinking: () => ThinkingContent | undefined;
  getTextIndex: () => number;
  getThinkingIndex: () => number;
}

export function createStreamDeltas(
  message: AssistantMessage,
  events: AssistantMessageEventStream,
): StreamDeltas {
  let text: TextContent | undefined;
  let thinking: ThinkingContent | undefined;
  let textIndex = -1;
  let thinkingIndex = -1;

  const textDelta = (delta: string) => {
    if (!text) {
      text = { type: "text", text: "" };
      textIndex = message.content.push(text) - 1;
      events.push({ type: "text_start", contentIndex: textIndex, partial: message });
    }
    text.text += delta;
    if (delta) events.push({ type: "text_delta", contentIndex: textIndex, delta, partial: message });
  };

  const thinkingDelta = (delta: string) => {
    if (!thinking) {
      thinking = { type: "thinking", thinking: "" };
      thinkingIndex = message.content.push(thinking) - 1;
      events.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: message });
    }
    thinking.thinking += delta;
    if (delta) events.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta, partial: message });
  };

  return {
    textDelta,
    thinkingDelta,
    getText: () => text,
    getThinking: () => thinking,
    getTextIndex: () => textIndex,
    getThinkingIndex: () => thinkingIndex,
  };
}
