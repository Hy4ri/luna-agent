// Workspace switching shared by session_worktree (start, switch, finish).
import type { Context } from "@earendil-works/chord/context";
import { configure, defineDoc, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { ExecTarget } from "./workers.js";

// A recovered invocation must not restore an old directory after a later workspace switch.
export const WorkspaceSwitch = defineDoc({
  kind: "luna.workspace-switch", version: 1, scope: "task",
  checkpointWhen: () => false,
  initial: () => ({ cwd: null as string | null }),
});

/** Point the session's file and shell tools at `absolute`. Idempotent per task, so a recovered call does not undo a later switch. */
export async function switchWorkspace(api: Pick<ToolExecutionApi, "taskId" | "conversationId" | "commit">, absolute: string, context: Context): Promise<string> {
  return api.commit(async tx => {
    const applied = await tx.doc(WorkspaceSwitch, api.taskId);
    if (applied.cwd) return applied.cwd;
    await configure(tx, api.conversationId, { cwd: absolute });
    const worker = (await tx.doc(ExecTarget, api.conversationId)).worker;
    await tx.appendEntry(api.conversationId, { kind: "luna.execution", data: { worker, cwd: absolute } });
    applied.cwd = absolute;
    return applied.cwd;
  }, context);
}
