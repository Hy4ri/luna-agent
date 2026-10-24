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
