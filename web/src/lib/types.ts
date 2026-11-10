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
  /** Real pending schedule state; changes independently of streamed message history. */
  scheduled?: { count: number; version: string };
  recovery?: {
    active: boolean;
    resumeAt?: number;
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
  /** Sessions isolate their first write in their own git worktree. */
  autoWorktree?: boolean;
  /** Command run in a new worktree, such as a dependency install. */
  worktreeSetup?: string;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
  /** Levels the model accepts; absent for unknown models. */
  thinkingLevels?: string[];
  /** Level a new session with this model starts at. */
  defaultThinkingLevel?: string;
  /** OpenAI service tiers the model accepts ("fast", "ultrafast"); absent or empty hides the speed button. */
  speeds?: string[];
  [key: string]: any;
}
