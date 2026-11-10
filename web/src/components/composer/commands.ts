import type { MentionCard, Status, Priority, SlashCommandItem, CommandCategory, MentionGroup, CommandGroup } from "./types";

const CATEGORY_ORDER: Status[] = ["todo", "backlog", "review", "in_progress", "done"];
const CATEGORY_LABEL: Record<Status, string> = {
  todo: "To do",
  backlog: "Backlog",
  review: "Review",
  in_progress: "In progress",
  done: "Done",
};
const PRIORITY_RANK: Record<Priority, number> = { urgent: 3, high: 2, medium: 1, low: 0 };

const COMMAND_CATEGORY_ORDER: CommandCategory[] = ["side", "busy", "session"];
const COMMAND_CATEGORY_LABEL: Record<CommandCategory, string> = {
  side: "Side & Skills",
  busy: "Busy & Queue",
  session: "Turn Control",
};

const SLASH_COMMANDS: SlashCommandItem[] = [
  { id: "usage", insert: "/usage", label: "/usage", description: "Show recorded session totals and Claude plan usage", category: "session" },
  { id: "cost", insert: "/cost", label: "/cost", description: "Alias for /usage", category: "session" },
  { id: "undo", insert: "/undo ", label: "/undo", args: "<N>", description: "Remove the last N user messages and replies from model context; keep chat history", category: "session" },
  { id: "btw", insert: "/btw ", label: "/btw", args: "<question>", description: "Ask a side question without tools or main history", category: "side" },
  { id: "bg", insert: "/bg ", label: "/bg", args: "<prompt>", description: "Run a background task with tools in a side conversation", category: "side" },
  { id: "review", insert: "/review", label: "/review", args: "[focus]", description: "Review this session's code and request coverage with a read-only model", category: "side" },
  { id: "learn", insert: "/learn ", label: "/learn", args: "<source> [objective]", description: "Study a URL, repo, or file and record a skill", category: "side" },
  { id: "grill", insert: "/grill ", label: "/grill", args: "<topic>", description: "Interview me about a plan until every decision is resolved", category: "side" },
  { id: "skillcraft", insert: "/skillcraft ", label: "/skillcraft", args: "<skill idea>", description: "Interview me to craft or update a skill", category: "side" },
  { id: "queue", insert: "/queue ", label: "/queue", args: "<message>", description: "Queue a follow-up message for the next turn", category: "busy" },
  { id: "steer", insert: "/steer ", label: "/steer", args: "<message>", description: "Steer the active turn at its next boundary", category: "busy" },
  { id: "queue list", insert: "/queue list", label: "/queue list", description: "List queued follow-up messages", category: "busy" },
  { id: "queue edit", insert: "/queue edit ", label: "/queue edit", args: "<N> <text>", description: "Edit queued message N", category: "busy" },
  { id: "queue remove", insert: "/queue remove ", label: "/queue remove", args: "<N>", description: "Remove queued message N", category: "busy" },
  { id: "queue move", insert: "/queue move ", label: "/queue move", args: "<A> <B>", description: "Move queued message A to position B", category: "busy" },
  { id: "queue clear", insert: "/queue clear", label: "/queue clear", description: "Clear all queued messages", category: "busy" },
  { id: "stop", insert: "/stop", label: "/stop", description: "Stop the active turn immediately", category: "session" },
  { id: "compact", insert: "/compact", label: "/compact", description: "Summarize older context now", category: "session" },
  { id: "models", insert: "/models", label: "/models", description: "Open the model picker", category: "session" },
  { id: "schedule", insert: "/schedule ", label: "/schedule", args: "<message>", description: "Schedule a message for a specific date and time", category: "busy" },
  { id: "schedule list", insert: "/schedule list", label: "/schedule list", description: "List pending scheduled messages", category: "busy" },
  { id: "schedule cancel", insert: "/schedule cancel ", label: "/schedule cancel", args: "<id>", description: "Cancel a scheduled message", category: "busy" },
];

export function filterAndSortMentionCards(cards: MentionCard[], query: string): MentionCard[] {
  const q = query.trim().toLowerCase();
  const isDigits = /^\d+$/.test(q);
  const filtered = cards.filter(c => {
    if (!q) return true;
    const idStr = String(c.id);
    if (isDigits) return idStr.startsWith(q);
    return idStr.startsWith(q) || c.subject.toLowerCase().includes(q) || c.labels.some(l => l.toLowerCase().includes(q));
  });
  return [...filtered].sort((a, b) => {
    const catDiff = CATEGORY_ORDER.indexOf(a.status) - CATEGORY_ORDER.indexOf(b.status);
    if (catDiff !== 0) return catDiff;
    const priDiff = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
    if (priDiff !== 0) return priDiff;
    return a.id - b.id;
  });
}

export function groupMentionCards(items: MentionCard[]): MentionGroup[] {
  const groups: MentionGroup[] = [];
  let flatIndex = 0;
  for (const status of CATEGORY_ORDER) {
    const inStatus = items.filter(c => c.status === status);
    if (!inStatus.length) continue;
    groups.push({
      status,
      label: CATEGORY_LABEL[status],
      items: inStatus.map(card => ({ card, flatIndex: flatIndex++ })),
    });
  }
  return groups;
}

export function filterSlashCommands(query: string): SlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(cmd => {
    if (cmd.id.startsWith(q) || cmd.label.slice(1).startsWith(q)) return true;
    const words = cmd.id.split(" ");
    if (!q.includes(" ") && words.some(w => w.startsWith(q))) return true;
    return false;
  });
}

export function groupSlashCommands(items: SlashCommandItem[]): CommandGroup[] {
  const groups: CommandGroup[] = [];
  let flatIndex = 0;
  for (const category of COMMAND_CATEGORY_ORDER) {
    const inCat = items.filter(c => c.category === category);
    if (!inCat.length) continue;
    groups.push({
      category,
      label: COMMAND_CATEGORY_LABEL[category],
      items: inCat.map(cmd => ({ cmd, flatIndex: flatIndex++ })),
    });
  }
  return groups;
}
