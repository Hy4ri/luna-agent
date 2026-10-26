// A native durable sleep enforces child budgets even while the parent is idle or the daemon restarts.
import { defineTask, type ConversationId } from "@earendil-works/pi-durable";
import { withChildControl } from "./delegate-control.js";
import { Children, readChildReport } from "./delegate-state.js";

type Input = { parent: number; child: number; deadline: number };
type State = { phase: "wait" } | { phase: "stop" };
export const DelegateDeadline = defineTask<Input, State, null>({
  name: "luna.delegate.deadline", version: 1, initial: () => ({ phase: "wait" }),
  phases: {
    async wait(task, runtime, context) {
      const { parent, child, deadline } = task.input;
      if (runtime.now() < deadline) { await runtime.sleepUntil(deadline, { phase: "wait" }, context); return; }
      await withChildControl(child, () => runtime.commit(async tx => {
        if (!await tx.conversation(parent as ConversationId) || !await tx.conversation(child as ConversationId))
          return { status: "terminal", outcome: { status: "completed", result: null } };
        const row = (await tx.doc(Children, parent as ConversationId)).children.find(c => c.id === child);
        if (!row || row.deadlineTask !== Number(runtime.taskId) || row.stopped || row.deadline !== deadline ||
            (await readChildReport(tx, parent as ConversationId, child)).state !== "running") {
          if (row?.deadlineTask === Number(runtime.taskId)) delete row.deadlineTask;
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }
        row.stopped = "timeout"; row.stopping = true;
        return { status: "running", checkpoint: { phase: "stop" } };
      }, context));
    },
    async stop(task, runtime, context) {
      const { parent, child, deadline } = task.input;
      await withChildControl(child, async () => {
        let current = false;
        await runtime.commit(async tx => {
          if (await tx.conversation(parent as ConversationId)) {
            const row = (await tx.doc(Children, parent as ConversationId)).children.find(c => c.id === child);
            current = row?.deadlineTask === Number(runtime.taskId) && row.deadline === deadline && row.stopped === "timeout" && row.stopping === true;
          }
          // A parent stop or steering can supersede this task between its durable phases.
          return current ? undefined : { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
        if (!current) return;
        await (await runtime.conversation(child as ConversationId, context))?.abort(context);
        await runtime.commit(async tx => {
          if (await tx.conversation(parent as ConversationId)) {
            const row = (await tx.doc(Children, parent as ConversationId)).children.find(c => c.id === child);
            if (row?.deadlineTask === Number(runtime.taskId)) { delete row.stopping; delete row.deadlineTask; }
          }
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      });
    },
  },
  async abort(_task, runtime, context) {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});
