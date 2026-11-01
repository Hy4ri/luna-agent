export type Status = "todo" | "backlog" | "review" | "in_progress" | "done";
export type Priority = "urgent" | "high" | "medium" | "low";

export type MentionCard = {
  id: number;
  project: number;
  subject: string;
  description: string;
  status: Status;
  priority: Priority;
  owner: string | null;
  labels: string[];
  blockedBy: number[];
  archived: boolean;
};

export type MentionGroup = {
  status: Status;
  label: string;
  items: { card: MentionCard; flatIndex: number }[];
};

export type CommandCategory = "side" | "busy" | "session";

export type SlashCommandItem = {
  id: string;
  insert: string;
  label: string;
  args?: string;
  description: string;
  category: CommandCategory;
};

export type CommandGroup = {
  category: CommandCategory;
  label: string;
  items: { cmd: SlashCommandItem; flatIndex: number }[];
};
