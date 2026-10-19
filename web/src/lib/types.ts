export interface SessionMeta {
  id: number | string;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  running?: boolean;
  project?: number | null;
  lastActivity?: number | null;
  createdAt?: number | null;
  [key: string]: any;
}

export interface Project {
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
