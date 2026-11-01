// Goal state document. Separate from goal.ts so session-status.ts can read it without an import cycle.
import { defineDoc } from "@earendil-works/pi-durable";

export type GoalStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete";
export type GoalTask = { id: string; title: string; status: "pending" | "complete" | "skipped"; verification?: string; evidence?: string; skipReason?: string };
export type Goal = {
  id: string;
  objective: string;
  mode: "regular" | "sisyphus";
  status: GoalStatus;
  statusReason?: string;
  verificationContract?: string;
  tasks: GoalTask[];
  audit: boolean;
  runs: number;
  /** Automatic continuations allowed before the goal pauses; 0 disables continuation. */
  maxRuns: number;
  /** Input boundary where an automatic continuation limit stopped work. */
  limitInput?: number;
  tokenBudget?: number;
  baseTokens: number;
  tokensUsed: number;
  created: number;
  lastAudit?: { approved: boolean; report: string; at: number };
};

export const GoalDoc = defineDoc<{ goal: Goal | null; seq: number }>({
  checkpointWhen: () => false,
  kind: "luna.goal",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ goal: null, seq: 0 }),
});
