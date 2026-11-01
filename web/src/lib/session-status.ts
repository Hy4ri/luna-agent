import type { SessionMeta, SessionStatus } from "./types";

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  ready: "Ready",
  running: "Running",
  reviewing: "Reviewing",
  review_finished: "Review finished",
  finished: "Finished",
  needs_approval: "Needs approval",
  needs_input: "Needs input",
  limit_reached: "Limit reached",
  failed: "Failed",
  stopped: "Stopped",
};

/** Older servers expose only running. Do not invent a finished outcome. */
export function sessionState(session?: Pick<SessionMeta, "status" | "running"> | null): SessionStatus {
  if (session?.status && Object.hasOwn(SESSION_STATUS_LABELS, session.status)) return session.status;
  return session?.running ? "running" : "ready";
}

export const sessionStatusLabel = (session?: Pick<SessionMeta, "status" | "running"> | null) => SESSION_STATUS_LABELS[sessionState(session)];

export function statusLabel(s: SessionStatus): string {
  return SESSION_STATUS_LABELS[s] || s;
}

export function statusChipClass(s: SessionStatus): string {
  switch (s) {
    case "running": return "border-blue-500/40 bg-blue-500/10 text-blue-400";
    case "finished": return "border-emerald-500/40 bg-emerald-500/10 text-emerald-400";
    case "needs_approval": return "border-amber-500/40 bg-amber-500/10 text-amber-400";
    case "needs_input": return "border-purple-500/40 bg-purple-500/10 text-purple-400";
    case "limit_reached": return "border-orange-500/40 bg-orange-500/10 text-orange-400";
    case "failed": return "border-destructive/40 bg-destructive/10 text-destructive";
    default: return "border-border bg-secondary text-foreground";
  }
}

