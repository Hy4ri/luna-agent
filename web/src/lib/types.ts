export type SessionStatus =
  | "ready"
  | "running"
  | "finished"
  | "needs_approval"
  | "needs_input"
  | "limit_reached"
  | "failed"
  | "stopped";

export interface SessionMeta {
  id: number | string;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  running?: boolean;
  status?: SessionStatus;
  statusReason?: string | null;
  /** Epoch ms when Luna continues after a usage limit; null when nothing is scheduled. */
  resumeAt?: number | null;
  project?: number | null;
  lastActivity?: number | null;
  createdAt?: number | null;
  [key: string]: any;
}

export interface Project {
  general?: boolean;
  id: number;
  name: string;
  cwd: string;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
  [key: string]: any;
}
