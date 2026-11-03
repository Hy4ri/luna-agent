import { posix } from "node:path";
import { configure, defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { ExecTarget } from "./workers.js";

// A recovered invocation must not restore an old directory after a later workspace switch.
const WorkspaceSwitch = defineDoc({
  kind: "luna.workspace-switch", version: 1, scope: "task",
  checkpointWhen: () => false,
  initial: () => ({ cwd: null as string | null }),
});

export const SessionWorkspaceExtension = defineExtension({
  name: "session-workspace",
  tools: [defineTool({
    name: "session_workspace",
    description: "Activate an existing directory as this session's workspace on its current machine. Updates default file/shell paths and the Git UI. Use explicitly when moving work into a worktree; creating or inspecting one does not switch. Does not move running processes or change the project or machine. Call separately before other work.",
    parameters: Type.Object({ path: Type.String({ minLength: 1, description: "Absolute directory path on this session's current machine." }) }, { additionalProperties: false }),
    executionMode: "sequential",
    replay: "safe",
    execute: async ({ path }, api, context) => {
      const text = (cwd: string) => ({ output: [{ type: "text" as const, text: `Active workspace: ${cwd}. Subsequent file and shell tools and the Git UI use this directory. Existing processes keep their original directories.` }] });
      const previous = await api.snapshot(WorkspaceSwitch, api.taskId, context);
      if (previous?.cwd) return text(previous.cwd);
      if (!path.trim() || !posix.isAbsolute(path) || path.includes("\0")) throw new Error("Workspace path must be an absolute directory path.");
      if (!api.env) throw new Error("This session has no execution environment.");
      const absolute = await api.env.absolutePath(path, context);
      if (!absolute.ok) throw new Error(absolute.error.message);
      // Validate through the session environment, including worker routing. Never inspect a worker path on the host.
      const directory = await api.env.openDirReader(absolute.value, context);
      if (!directory.ok) throw new Error(`Cannot activate workspace: ${directory.error.message}`);
      await directory.value.close(context);
      const cwd = await api.commit(async tx => {
        const applied = await tx.doc(WorkspaceSwitch, api.taskId);
        if (applied.cwd) return applied.cwd;
        await configure(tx, api.conversationId, { cwd: absolute.value });
        const worker = (await tx.doc(ExecTarget, api.conversationId)).worker;
        await tx.appendEntry(api.conversationId, { kind: "luna.execution", data: { worker, cwd: absolute.value } });
        applied.cwd = absolute.value;
        return applied.cwd;
      }, context);
      return text(cwd);
    },
  })],
});
