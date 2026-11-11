import type { JsonValue } from "@earendil-works/chord/json";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import type {
  CompactionFailure,
  CompactionReason,
  CompactionStatus,
  EntryRecord,
  NestedToolExecutionResult,
  NestedToolSlot,
  RunFailure,
  SubmissionId,
  SubmissionRecord,
  TaskId,
  ToolDiagnostic,
  ToolSlot,
  UsageState,
  WatchEnd,
} from "@earendil-works/pi-durable";

export type Block = AssistantMessage["content"][number];

export type QueuedItem = {
  id: SubmissionId;
  mode: "steer" | "followUp";
};

export type MessageChange =
  | {
      type: "text_start" | "thinking_start" | "toolcall_start";
      contentIndex: number;
      block: Block;
    }
  | {
      type: "text_delta" | "thinking_delta";
      contentIndex: number;
      delta: string;
    }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      path: readonly (string | number)[];
      delta: string;
    }
  | {
      type: "block";
      contentIndex: number;
      block: Block;
    }
  | {
      type: "message";
      message: AssistantMessage;
    };

export type SnapshotEvent = {
  type: "snapshot";
  entries: readonly EntryRecord[];
  run?: {
    inputs: readonly SubmissionId[];
  };
  generation?: {
    attempt: number;
    message?: AssistantMessage;
    retry?: {
      at: number;
      error: string;
    };
    deferred?: {
      pollAt: number;
    };
  };
  tools: readonly ToolSlot[];
  nestedTools: readonly NestedToolSlot[];
  compactions: readonly CompactionStatus[];
  compactionFailure?: CompactionFailure;
  runFailure?: RunFailure;
  inbox: readonly QueuedItem[];
  agent: Record<string, unknown>;
  usage: UsageState;
};

export type ToolEventCall = {
  toolCallId: string;
  toolName: string;
  taskId?: TaskId;
  parentToolCallId?: string;
  parentTaskId?: TaskId;
};

export type AgentEvent =
  | SnapshotEvent
  | {
      type: "run_start";
      inputs: readonly SubmissionId[];
    }
  | {
      type: "run_end";
      inputs: readonly SubmissionId[];
    }
  | {
      type: "turn_start";
    }
  | {
      type: "turn_end";
    }
  | {
      type: "message_start";
      message: Message;
    }
  | {
      type: "message_update";
      usage: Usage;
      changes: readonly MessageChange[];
    }
  | {
      type: "message_end";
      entry: EntryRecord;
    }
  | ({
      type: "tool_execution_start";
      args: JsonObject;
    } & ToolEventCall)
  | ({
      type: "tool_execution_update";
      output?:
        | {
            trimStart?: number;
            append?: string;
          }
        | {
            set: string;
          };
      details?: JsonValue;
      diagnostics?: readonly ToolDiagnostic[];
    } & ToolEventCall)
  | ({
      type: "tool_execution_end";
      entry?: EntryRecord;
      result?: NestedToolExecutionResult;
    } & ToolEventCall)
  | {
      type: "inbox_update";
      items: readonly QueuedItem[];
    }
  | {
      type: "submission";
      record: SubmissionRecord;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      at: number;
      errorMessage: string;
    }
  | {
      type: "auto_retry_end";
      attempt: number;
    }
  | {
      type: "deferred_poll";
      pollAt: number;
    }
  | {
      type: "entry_appended";
      entry: EntryRecord;
    }
  | {
      type: "agent_changed";
      agent: Record<string, unknown>;
    }
  | {
      type: "usage_changed";
      usage: UsageState;
    }
  | {
      type: "task_failed";
      taskId: TaskId;
      kind: string;
      message: string;
    }
  | {
      type: "compaction_start";
      taskId: TaskId;
      reason: CompactionReason;
      blocking: boolean;
    }
  | {
      type: "compaction_end";
      taskId: TaskId;
      reason: CompactionReason;
      error?: string;
    }
  | {
      type: "run_failure";
      taskId: TaskId;
      reason: string;
      detail?: string;
    };

export interface AgentEventStream {
  readonly snapshot: SnapshotEvent;
  start(listener: (events: readonly AgentEvent[], context?: unknown) => Promise<void>): void;
  flush(): Promise<void>;
  stop(): Promise<WatchEnd>;
  readonly closed: Promise<WatchEnd>;
}

export type SessionFeedOptions = {
  readonly minWindow?: number;
  readonly maxWindow?: number;
  readonly from?: number;
  /** Undelivered batches a slow viewer may hold before the feed ends (default 1024). The client reconnects with its cursor. */
  readonly maxQueuedBatches?: number;
};
