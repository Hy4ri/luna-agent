import type { ProjectAppearance } from "../../../src/project-appearance";

export type SessionStatus =
  | "ready"
  | "running"
  | "reviewing"
  | "review_finished"
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
  recovery?: {
    active: boolean;
    resumeAt?: number;
    attempt: number;
    maxAttempts: number;
    exact: boolean;
    source?: string;
    pausedReason?: string;
  } | null;
  project?: number | null;
  /** Execution machine of the session: a worker id, or null for the main host. */
  worker?: number | null;
  lastActivity?: number | null;
  createdAt?: number | null;
  [key: string]: any;
}

export interface Project extends ProjectAppearance {
  general?: boolean;
  /** Favourite projects are listed first everywhere. Stored on the server. */
  favorite?: boolean;
  id: number;
  name: string;
  /** Working directory on the main host. */
  cwd: string;
  /** Working directories on execution workers. One project, one board, a directory per machine. */
  workerDirs?: { worker: number; cwd: string }[];
}

export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
  [key: string]: any;
}
