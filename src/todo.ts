// `todo` tool: a port of @juicesharp/rpiv-todo (MIT, most-downloaded Pi todo package) onto pi-durable.
// Same tool contract: actions, 4-state machine, blockedBy graph with cycle checks, response text. State lives in a
// rewindable conversation document, so it follows the branch: a fork starts with the todos it had at the fork entry.
import { Type, type Static } from "typebox";
import type { JsonValue } from "@earendil-works/chord";
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";
export type Task = {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, JsonValue>;
};
export type TaskState = { tasks: Task[]; nextId: number };

export const TodoDoc = defineDoc<{ tasks: Task[]; nextId: number }>({
  checkpointWhen: () => false,
  kind: "luna.todo",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ tasks: [], nextId: 1 }),
});

export const TodoParams = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("list"), Type.Literal("get"), Type.Literal("delete"), Type.Literal("clear")]),
  subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
  description: Type.Optional(Type.String({ description: "Long-form task description" })),
  activeForm: Type.Optional(Type.String({ description: "Present-continuous label shown while status is in_progress (e.g. 'writing tests')" })),
  status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("deleted")], {
    description: "Set this task's status (update): one of pending, in_progress, completed, deleted. When action is list, filters returned tasks by this status.",
  })),
  blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Initial blockedBy ids (create only)" })),
  addBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Task ids to add to blockedBy (update only, additive merge)" })),
  removeBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Task ids to remove from blockedBy (update only, additive merge)" })),
  owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata; pass null value for a key to delete that key on update" })),
  id: Type.Optional(Type.Number({ description: "Task id (required for update, get, delete)" })),
  includeDeleted: Type.Optional(Type.Boolean({ description: "If true, list action returns deleted (tombstoned) tasks as well. Default: false." })),
});
export type TodoArgs = Static<typeof TodoParams>;

const VALID: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set(["in_progress", "completed", "deleted"]),
  in_progress: new Set(["pending", "completed", "deleted"]),
  completed: new Set(["deleted"]),
  deleted: new Set(),
};
const transitionOk = (from: TaskStatus, to: TaskStatus) => from === to || VALID[from].has(to);

export function detectCycle(list: readonly Task[], taskId: number, newBlockedBy: readonly number[]): boolean {
  const edges = new Map<number, number[]>();
  for (const t of list) edges.set(t.id, t.id === taskId ? [...new Set([...(t.blockedBy ?? []), ...newBlockedBy])] : [...(t.blockedBy ?? [])]);
  const visiting = new Set<number>(), visited = new Set<number>();
  const from = (n: number): boolean => {
    if (visiting.has(n)) return true;
    if (visited.has(n)) return false;
    visiting.add(n);
    for (const nb of edges.get(n) ?? []) if (from(nb)) return true;
    visiting.delete(n); visited.add(n);
    return false;
  };
  for (const n of edges.keys()) if (from(n)) return true;
  return false;
}

export type Op =
  | { kind: "create"; taskId: number }
  | { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus; changed: boolean }
  | { kind: "delete"; id: number; subject: string }
  | { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
  | { kind: "get"; task: Task }
  | { kind: "clear"; count: number }
  | { kind: "error"; message: string };

export const changesState = (op: Op) => op.kind === "create" || op.kind === "delete" || op.kind === "clear" || (op.kind === "update" && op.changed);

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Pure reducer, same validation and messages as rpiv-todo. */
export function applyTodo(state: TaskState, p: TodoArgs): { state: TaskState; op: Op } {
  const err = (message: string) => ({ state, op: { kind: "error" as const, message } });
  switch (p.action) {
    case "create": {
      if (!p.subject?.trim()) return err("subject required for create");
      for (const dep of p.blockedBy ?? []) {
        const d = state.tasks.find((t) => t.id === dep);
        if (!d) return err(`blockedBy: #${dep} not found`);
        if (d.status === "deleted") return err(`blockedBy: #${dep} is deleted`);
      }
      const t: Task = { id: state.nextId, subject: p.subject, status: "pending" };
      if (p.description) t.description = p.description;
      if (p.activeForm) t.activeForm = p.activeForm;
      if (p.blockedBy?.length) t.blockedBy = [...p.blockedBy];
      if (p.owner) t.owner = p.owner;
      if (p.metadata) t.metadata = { ...p.metadata } as Record<string, JsonValue>;
      return { state: { tasks: [...state.tasks, t], nextId: state.nextId + 1 }, op: { kind: "create", taskId: t.id } };
    }
    case "update": {
      if (p.id === undefined) return err("id required for update");
      const idx = state.tasks.findIndex((t) => t.id === p.id);
      if (idx === -1) return err(`#${p.id} not found`);
      const cur = state.tasks[idx]!;
      const has = p.subject !== undefined || p.description !== undefined || p.activeForm !== undefined || p.status !== undefined
        || p.owner !== undefined || p.metadata !== undefined || !!p.addBlockedBy?.length || !!p.removeBlockedBy?.length;
      if (!has) return err("update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy");
      let status = cur.status;
      if (p.status !== undefined) {
        if (!transitionOk(cur.status, p.status)) return err(`illegal transition ${cur.status} → ${p.status}`);
        status = p.status;
      }
      let blocked = [...(cur.blockedBy ?? [])];
      if (p.removeBlockedBy?.length) { const rm = new Set(p.removeBlockedBy); blocked = blocked.filter((d) => !rm.has(d)); }
      if (p.addBlockedBy?.length) {
        for (const dep of p.addBlockedBy) {
          if (dep === cur.id) return err(`cannot block #${cur.id} on itself`);
          const d = state.tasks.find((t) => t.id === dep);
          if (!d) return err(`addBlockedBy: #${dep} not found`);
          if (d.status === "deleted") return err(`addBlockedBy: #${dep} is deleted`);
          if (!blocked.includes(dep)) blocked.push(dep);
        }
        if (detectCycle(state.tasks, cur.id, blocked)) return err("addBlockedBy would create a cycle in the blockedBy graph");
      }
      let meta = cur.metadata;
      if (p.metadata !== undefined) {
        const m: Record<string, JsonValue> = { ...(cur.metadata ?? {}) };
        for (const [k, v] of Object.entries(p.metadata)) { if (v === null) delete m[k]; else m[k] = v as JsonValue; }
        meta = Object.keys(m).length ? m : undefined;
      }
      const up: Task = { ...cur, status };
      if (p.subject !== undefined) up.subject = p.subject;
      if (p.description !== undefined) up.description = p.description;
      if (p.activeForm !== undefined) up.activeForm = p.activeForm;
      if (p.owner !== undefined) up.owner = p.owner;
      if (blocked.length) up.blockedBy = blocked; else delete up.blockedBy;
      if (meta === undefined) delete up.metadata; else up.metadata = meta;
      const changed = up.subject !== cur.subject || up.status !== cur.status || up.description !== cur.description || up.activeForm !== cur.activeForm
        || up.owner !== cur.owner || !same(up.blockedBy, cur.blockedBy) || !same(up.metadata, cur.metadata);
      const tasks = [...state.tasks]; tasks[idx] = up;
      return { state: { tasks, nextId: state.nextId }, op: { kind: "update", id: up.id, fromStatus: cur.status, toStatus: status, changed } };
    }
    case "list":
      return { state, op: { kind: "list", includeDeleted: p.includeDeleted === true, ...(p.status !== undefined ? { statusFilter: p.status } : {}) } };
    case "get": {
      if (p.id === undefined) return err("id required for get");
      const task = state.tasks.find((t) => t.id === p.id);
      return task ? { state, op: { kind: "get", task } } : err(`#${p.id} not found`);
    }
    case "delete": {
      if (p.id === undefined) return err("id required for delete");
      const idx = state.tasks.findIndex((t) => t.id === p.id);
      if (idx === -1) return err(`#${p.id} not found`);
      const cur = state.tasks[idx]!;
      if (cur.status === "deleted") return err(`#${cur.id} is already deleted`);
      const tasks = [...state.tasks]; tasks[idx] = { ...cur, status: "deleted" };
      return { state: { tasks, nextId: state.nextId }, op: { kind: "delete", id: cur.id, subject: cur.subject } };
    }
    case "clear":
      return { state: { tasks: [], nextId: 1 }, op: { kind: "clear", count: state.tasks.length } };
  }
}

const clean = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const line = (t: Task) => {
  const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((i) => `#${i}`).join(",")}` : "";
  const form = t.status === "in_progress" && t.activeForm ? ` (${clean(t.activeForm)})` : "";
  return `[${t.status}] #${t.id} ${clean(t.subject)}${form}${block}`;
};

export function formatOp(op: Op, state: TaskState): string {
  switch (op.kind) {
    case "create": { const t = state.tasks.find((x) => x.id === op.taskId); return t ? `Created #${t.id}: ${clean(t.subject)} (pending)` : `Created #${op.taskId}`; }
    case "update":
      if (!op.changed) return `No change: #${op.id} already matches the requested values (status: ${op.toStatus})`;
      return `Updated #${op.id}${op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : ""}`;
    case "delete": return `Deleted #${op.id}: ${clean(op.subject)}`;
    case "clear": return `Cleared ${op.count} tasks`;
    case "list": {
      let v = state.tasks;
      if (!op.includeDeleted) v = v.filter((t) => t.status !== "deleted");
      if (op.statusFilter) v = v.filter((t) => t.status === op.statusFilter);
      return v.length ? v.map(line).join("\n") : "No tasks";
    }
    case "get": {
      const t = op.task, blocks = state.tasks.filter((x) => x.blockedBy?.includes(t.id)).map((x) => x.id);
      const out = [`#${t.id} [${t.status}] ${clean(t.subject)}`];
      if (t.description) out.push(`  description: ${clean(t.description)}`);
      if (t.activeForm) out.push(`  activeForm: ${clean(t.activeForm)}`);
      if (t.blockedBy?.length) out.push(`  blockedBy: ${t.blockedBy.map((i) => `#${i}`).join(", ")}`);
      if (blocks.length) out.push(`  blocks: ${blocks.map((i) => `#${i}`).join(", ")}`);
      if (t.owner) out.push(`  owner: ${clean(t.owner)}`);
      return out.join("\n");
    }
    case "error": return `Error: ${op.message}`;
  }
}

// rpiv-todo's tool description plus its prompt guidelines (the tool schema carries them, so no extra prompt section).
const DESCRIPTION = [
  "Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation. The user sees the list live.",
  "- Use todo for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
  "- When starting a task, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done; never batch completions. Exactly one task in_progress at a time.",
  "- Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors; keep it in_progress and create a new task for the blocker instead.",
  "- Pass activeForm (present-continuous label) when marking in_progress. Change status with update, e.g. {\"action\":\"update\",\"id\":3,\"status\":\"completed\"}.",
  "- Use blockedBy on create; addBlockedBy / removeBlockedBy on update (additive merge). Cycles are rejected. list hides deleted tasks unless includeDeleted:true.",
].join("\n");

export const Todo = defineExtension({
  name: "todo",
  tools: [
    defineTool({
      name: "todo",
      description: DESCRIPTION,
      parameters: TodoParams,
      execute: async (args, api, context) => {
        const { text, state, isError } = await api.commit(async (tx) => {
          const doc = await tx.doc(TodoDoc, api.conversationId);
          const before: TaskState = { tasks: JSON.parse(JSON.stringify(doc.tasks)), nextId: doc.nextId };
          const r = applyTodo(before, args);
          if (changesState(r.op)) { doc.tasks = r.state.tasks as never; doc.nextId = r.state.nextId; }
          return { text: formatOp(r.op, r.state), state: r.state, isError: r.op.kind === "error" };
        }, context);
        return { output: [{ type: "text", text }], details: { tasks: state.tasks, nextId: state.nextId } as never, isError };
      },
    }),
  ],
});
