// Create a full top-level session: the same rules for the web UI (POST /v1/sessions) and the session_crew tool.
// The plan is checked first; the commit part runs inside the caller's transaction so a tool can make it idempotent.
import { configure, type AgentChange, type ConversationId, type Extension, type Tx } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import { ExecTarget, type WorkerStore } from "./workers.js";
import type { ProjectStore } from "./projects.js";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export class SessionCreateError extends Error { constructor(readonly status: 400, message: string) { super(message); } }

export interface SessionRequest {
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  instructions?: string;
  cwd?: string;
  project?: number | null;
  worker?: number | null;
}
export interface SessionDeps {
  /** Default agent for a new session (default model, thinking level, instructions). */
  base: () => AgentChange;
  models?: Pick<Models, "getModel">;
  projects?: ProjectStore;
  workers?: Pick<WorkerStore, "get">;
  /** Extensions added to sessions created in a project (the board). */
  projectExtensions?: readonly Extension[];
}
export interface SessionPlan { agent: AgentChange; worker: number | null; cwd: string | undefined; project: number | undefined }

/** Validate a request and resolve its agent. Throws SessionCreateError for bad input. */
export function planSession(deps: SessionDeps, b: SessionRequest): SessionPlan {
  const worker = b.worker ?? null;
  if (worker !== null && (!Number.isSafeInteger(worker) || !deps.workers?.get(worker))) throw new SessionCreateError(400, "unknown worker");
  if (b.model && deps.models && !deps.models.getModel(b.model.provider as never, b.model.modelId as never)) throw new SessionCreateError(400, "unknown model");
  if (b.thinkingLevel !== undefined && !(THINKING_LEVELS as readonly string[]).includes(b.thinkingLevel)) throw new SessionCreateError(400, "invalid thinkingLevel");
  // Named projects supply a cwd; General preserves the normal session default.
  let project;
  if (b.project !== undefined && b.project !== null) {
    project = deps.projects?.get(b.project);
    if (!project) throw new SessionCreateError(400, "unknown project");
  }
  // A project has one directory per machine. Without one, a worker session uses the worker's default directory.
  const projectCwd = project ? deps.projects?.dirFor(project.id, worker) : undefined;
  if (project && !project.general && !projectCwd) throw new SessionCreateError(400, "project is not linked to this machine");
  const cwd = b.cwd || projectCwd;
  const agent: AgentChange = { ...deps.base(), ...(b.model && { model: b.model }), ...(b.thinkingLevel !== undefined && { thinkingLevel: b.thinkingLevel as ThinkingLevel }),
    ...(b.instructions && { instructions: b.instructions }), ...(cwd && { cwd }),
    ...(project && deps.projectExtensions?.length && { extensions: { add: deps.projectExtensions } }) };
  return { agent, worker, cwd, project: project?.id };
}

/** Create the planned session in `tx`. Link the project with `linkProject` after the commit. */
export async function createPlannedSession(tx: Tx, plan: SessionPlan): Promise<ConversationId> {
  const id = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
  await configure(tx, id, plan.agent);
  (await tx.doc(ExecTarget, id)).worker = plan.worker;
  await tx.appendEntry(id, { kind: "luna.execution", data: { worker: plan.worker, cwd: plan.cwd ?? null } });
  return id;
}

export function linkProject(projects: ProjectStore | undefined, id: number, plan: SessionPlan) {
  if (plan.project !== undefined) projects?.link(id, plan.project);
}
