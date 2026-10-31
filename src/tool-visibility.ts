import type { Message } from "@earendil-works/pi-ai";

/** Request-only projection: a hidden tool must have neither declarations nor removals on the wire. */
export function filterHiddenTools(messages: readonly Message[], hidden: ReadonlySet<string>): Message[] {
  return messages.map(message => {
    if (message.role !== "system" ||
      !message.toolsAdded?.some(tool => hidden.has(tool.name)) &&
      !message.toolsRemoved?.some(tool => hidden.has(tool.name))) return message;
    return {
      ...message,
      ...(message.toolsAdded ? { toolsAdded: message.toolsAdded.filter(tool => !hidden.has(tool.name)) } : {}),
      ...(message.toolsRemoved ? { toolsRemoved: message.toolsRemoved.filter(tool => !hidden.has(tool.name)) } : {}),
    };
  });
}
