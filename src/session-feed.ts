import type { Context } from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type CommitChange,
  type CompactionFailure,
  type CompactionReason,
  type CompactionStatus,
  type Conversation,
  type ConversationView,
  type ConversationWindow,
  type EntryId,
  type EntryRecord,
  type JsonObject,
  type Harness,
  type NestedToolExecutionResult,
  type NestedToolSlot,
  type RunFailure,
  type SubmissionRecord,
  type TaskId,
  type TaskRecord,
  type ToolSlot,
  type WatchEnd,
  UsageDoc,
} from "@earendil-works/pi-durable";
import type {
  AgentEvent,
  AgentEventStream,
  MessageChange,
  QueuedItem,
  SessionFeedOptions,
  SnapshotEvent,
  ToolEventCall,
} from "./session-feed-types.js";

type LiveSlot = ToolSlot;
type LiveNestedSlot = NestedToolSlot;

type ViewParts = {
  live: {
    run?: { inputs: number[]; turns?: number; taskId?: number; first?: number };
    generation?: {
      attempt: number;
      message?: AssistantMessage;
      retry?: { at: number; error: string };
      deferred?: { pollAt: number };
    };
    tools?: LiveSlot[];
    nestedTools?: LiveNestedSlot[];
    compactions?: Array<{ taskId: TaskId; trigger: CompactionReason; blocking: boolean; attempt: number }>;
    compactionFailure?: { taskId: TaskId; trigger: CompactionReason; error: string };
    runFailure?: RunFailure;
  };
  inbox: { items?: Array<{ id: number; mode: "steer" | "followUp" }> } | undefined;
  agent: Record<string, unknown> | undefined;
  usage: Record<string, unknown> | undefined;
};

function parts(view: ConversationView): ViewParts {
  return {
    live: (view.docs["pi.live"] ?? {}) as ViewParts["live"],
    inbox: view.docs["pi.inbox"] as ViewParts["inbox"],
    agent: view.docs["pi.agent"] as ViewParts["agent"],
    usage: view.docs["pi.usage"] as ViewParts["usage"],
  };
}

function queued(inbox: ViewParts["inbox"]): readonly QueuedItem[] {
  return (inbox?.items ?? []).map((item) => ({ id: item.id as unknown as QueuedItem["id"], mode: item.mode }));
}

export function snapshotOf(view: ConversationView): SnapshotEvent {
  const { live, inbox, agent, usage } = parts(view);
  const compactions: CompactionStatus[] = (live.compactions ?? []).map((c) => ({
    taskId: c.taskId as any,
    trigger: c.trigger,
    blocking: c.blocking,
    attempt: c.attempt,
  }));
  const compactionFailure: CompactionFailure | undefined = live.compactionFailure
    ? {
        taskId: live.compactionFailure.taskId as any,
        trigger: live.compactionFailure.trigger,
        error: live.compactionFailure.error,
      }
    : undefined;

  return {
    type: "snapshot",
    entries: view.entries,
    ...(live.run === undefined ? {} : { run: { inputs: live.run.inputs as unknown as QueuedItem["id"][] } }),
    ...(live.generation === undefined ? {} : { generation: live.generation as unknown as SnapshotEvent["generation"] }),
    tools: (live.tools ?? []) as unknown as SnapshotEvent["tools"],
    nestedTools: (live.nestedTools ?? []) as unknown as SnapshotEvent["nestedTools"],
    compactions,
    ...(compactionFailure === undefined ? {} : { compactionFailure }),
    ...(live.runFailure === undefined ? {} : { runFailure: live.runFailure }),
    inbox: queued(inbox),
    agent: (agent ?? AgentDoc.definition.initial()) as unknown as SnapshotEvent["agent"],
    usage: (usage ?? UsageDoc.definition.initial()) as unknown as SnapshotEvent["usage"],
  };
}

function resultOf(entries: readonly EntryRecord[], callId: string): EntryRecord | undefined {
  return entries.find((entry) => {
    const message = entry.model?.[0] as { role?: string; toolCallId?: string } | undefined;
    return message?.role === "toolResult" && message.toolCallId === callId;
  });
}

function startsWith(path: readonly (string | number)[], prefix: readonly (string | number)[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

const PARTIAL_PATH = ["docs", "pi.live", "generation", "message"];

function messageChanges(viewOps: readonly Op[], message: AssistantMessage): MessageChange[] {
  const changes: MessageChange[] = [];
  const whole = new Set<number>();

  for (const op of viewOps) {
    const path = op[1] as readonly (string | number)[];
    if (!startsWith(path, PARTIAL_PATH)) {
      if (startsWith(PARTIAL_PATH, path)) return [{ type: "message", message }];
      continue;
    }
    const rest = path.slice(PARTIAL_PATH.length);
    if (rest[0] === "usage") continue;
    if (rest[0] !== "content") return [{ type: "message", message }];
    if (rest.length === 1) {
      if (op[0] !== "p" || (op[3] as number) !== 0) return [{ type: "message", message }];
      const blocks = op[4] as unknown as AssistantMessage["content"];
      for (const [offset, block] of blocks.entries()) {
        const type =
          block.type === "text"
            ? "text_start"
            : block.type === "thinking"
              ? "thinking_start"
              : "toolcall_start";
        changes.push({ type, contentIndex: (op[2] as number) + offset, block });
      }
      continue;
    }
    const contentIndex = rest[1] as number;
    const field = rest[2];
    if (whole.has(contentIndex)) continue;
    if (op[0] === "a" && rest.length === 3 && (field === "text" || field === "thinking")) {
      changes.push({
        type: field === "text" ? "text_delta" : "thinking_delta",
        contentIndex,
        delta: op[2] as string,
      });
    } else if (op[0] === "a" && field === "arguments") {
      changes.push({
        type: "toolcall_delta",
        contentIndex,
        path: rest.slice(3) as readonly (string | number)[],
        delta: op[2] as string,
      });
    } else {
      whole.add(contentIndex);
      changes.push({ type: "block", contentIndex, block: message.content[contentIndex]! });
    }
  }
  return changes;
}

function callOf(slot: LiveSlot | LiveNestedSlot): ToolEventCall {
  return {
    toolCallId: slot.callId,
    toolName: slot.name,
    ...(slot.taskId === undefined ? {} : { taskId: slot.taskId }),
    ...("parentCallId" in slot
      ? {
          parentToolCallId: (slot as LiveNestedSlot).parentCallId,
          parentTaskId: (slot as LiveNestedSlot).parentTaskId,
        }
      : {}),
  };
}

function toolUpdate(
  viewOps: readonly Op[],
  at: readonly (string | number)[],
  slot: LiveSlot | LiveNestedSlot,
  previous: LiveSlot | LiveNestedSlot,
) {
  const outputPath = ["docs", "pi.live", ...at, "output"];
  let trimStart = 0;
  let append = "";
  let set = false;
  for (const op of viewOps) {
    if (!startsWith(op[1] as readonly (string | number)[], outputPath)) continue;
    if (op[0] === "t") trimStart += op[2] as number;
    else if (op[0] === "a") append += op[2] as string;
    else set = true;
  }
  let output: { trimStart?: number; append?: string } | { set: string } | undefined;
  if (set || (slot.output !== previous.output && trimStart === 0 && append === "")) {
    output = { set: slot.output ?? "" };
  } else if (trimStart > 0 || append !== "") {
    output = { ...(trimStart > 0 ? { trimStart } : {}), ...(append === "" ? {} : { append }) };
  }
  const update = {
    ...(output === undefined ? {} : { output }),
    ...(slot.details === previous.details ? {} : { details: slot.details ?? null }),
    ...(slot.diagnostics === previous.diagnostics ? {} : { diagnostics: slot.diagnostics ?? [] }),
  };
  return Object.keys(update).length === 0 ? undefined : update;
}

function translateEvents(
  before: ConversationView,
  after: ConversationView,
  viewOps: readonly Op[],
  publicationChanges: readonly CommitChange[],
  heldGenerations: Set<number>,
): AgentEvent[] {
  const entries: EntryRecord[] = [];
  const tasks = new Map<number, TaskRecord<any, any, any>>();
  const submissions: SubmissionRecord[] = [];
  const nestedResults = new Map<number, NestedToolExecutionResult>();

  for (const change of publicationChanges) {
    if (change.type === "document" && change.kind === "change" && change.record.kind === "pi.tool.nested-call") {
      const state = change.value as { taskId?: number; result?: NestedToolExecutionResult };
      if (state.taskId !== undefined && state.result !== undefined) {
        nestedResults.set(state.taskId, state.result);
      }
    } else if (change.type === "entry") {
      entries.push(change.value);
    } else if (change.type === "task") {
      tasks.set(change.value.id as number, change.value);
    } else if (change.type === "submission") {
      submissions.push(change.value);
    }
  }

  if (viewOps.length === 0 && entries.length === 0 && tasks.size === 0 && submissions.length === 0) {
    return [];
  }

  submissions.sort((a, b) => (a.id as number) - (b.id as number));
  const was = parts(before);
  const now = parts(after);
  const events: AgentEvent[] = [];

  const slotsBefore = new Map((was.live.tools ?? []).map((slot) => [slot.callId, slot]));
  const slots = now.live.tools ?? [];
  const nestedBefore = new Map((was.live.nestedTools ?? []).map((slot) => [slot.taskId, slot]));
  const nested = now.live.nestedTools ?? [];

  for (const slot of [...slots, ...nested]) {
    const previous = "parentCallId" in slot ? nestedBefore.get(slot.taskId) : slotsBefore.get(slot.callId);
    if (slot.status !== "running" || previous?.status === "running") continue;
    const checkpoint = slot.taskId === undefined ? undefined : tasks.get(slot.taskId as number)?.state?.checkpoint;
    const args =
      "parentCallId" in slot
        ? (slot as LiveNestedSlot).arguments
        : ((checkpoint?.arguments ?? {}) as JsonObject);
    events.push({ type: "tool_execution_start", ...callOf(slot), args });
  }

  const partialBefore = was.live.generation?.message;
  const partial = now.live.generation?.message;
  if (partial !== undefined && partialBefore === undefined) {
    events.push({ type: "message_start", message: partial });
  } else if (partial !== undefined && partial !== partialBefore) {
    events.push({
      type: "message_update",
      usage: partial.usage as Usage,
      changes: messageChanges(viewOps, partial),
    });
  }

  for (const [index, slot] of slots.entries()) {
    const previous = slotsBefore.get(slot.callId);
    if (slot.status !== "running" || previous?.status !== "running") continue;
    const update = toolUpdate(viewOps, ["tools", index], slot, previous!);
    if (update === undefined) continue;
    events.push({ type: "tool_execution_update", ...callOf(slot), ...update });
  }

  for (const [index, slot] of nested.entries()) {
    const previous = nestedBefore.get(slot.taskId);
    if (slot.status !== "running" || previous?.status !== "running") continue;
    const update = toolUpdate(viewOps, ["nestedTools", index], slot, previous!);
    if (update === undefined) continue;
    events.push({ type: "tool_execution_update", ...callOf(slot), ...update });
  }

  const generation = now.live.generation;
  const generationBefore = was.live.generation;
  if (generation?.retry !== undefined && generationBefore?.retry === undefined) {
    const { at, error } = generation.retry;
    events.push({ type: "auto_retry_start", attempt: generation.attempt, at, errorMessage: error });
  }
  if (generationBefore?.retry !== undefined && generation?.retry === undefined) {
    events.push({ type: "auto_retry_end", attempt: generationBefore.attempt });
  }
  if (generation?.deferred !== undefined && generation.deferred.pollAt !== generationBefore?.deferred?.pollAt) {
    events.push({ type: "deferred_poll", pollAt: generation.deferred.pollAt });
  }

  const toolEnds: AgentEvent[] = [];
  const endTool = (slot: LiveSlot | LiveNestedSlot, entryId: number | undefined) => {
    const entry = entries.find((candidate) => (candidate.id as number) === entryId);
    toolEnds.push({
      type: "tool_execution_end",
      ...callOf(slot),
      ...(entry === undefined ? {} : { entry }),
    });
  };

  for (const previous of slotsBefore.values()) {
    if (previous.status === "done") continue;
    const slot = slots.find((candidate) => candidate.callId === previous.callId);
    if (slot?.status === "done") {
      endTool(slot, slot.entry as number | undefined);
    } else if (slot === undefined) {
      endTool(previous, resultOf(entries, previous.callId)?.id as number | undefined);
    }
  }

  for (const slot of slots) {
    if (slot.status === "done" && !slotsBefore.has(slot.callId)) {
      endTool(slot, slot.entry as number | undefined);
    }
  }

  const endNested = (slot: LiveNestedSlot) => {
    const result = nestedResults.get(slot.taskId as number);
    events.push({
      type: "tool_execution_end",
      ...callOf(slot),
      ...(result === undefined ? {} : { result }),
    });
  };

  const nestedNow = new Map(nested.map((slot) => [slot.taskId, slot]));
  for (const previous of [...nestedBefore.values()].reverse()) {
    if (previous.status === "done") continue;
    const slot = nestedNow.get(previous.taskId);
    if (slot?.status === "done" || slot === undefined) {
      endNested(slot ?? previous);
    }
  }
  for (const slot of [...nested].reverse()) {
    if (slot.status === "done" && !nestedBefore.has(slot.taskId)) {
      endNested(slot);
    }
  }

  let assistantAppended = false;
  for (const entry of entries) {
    events.push(...toolEnds.filter((end) => (end as { entry?: EntryRecord }).entry === entry));
    const message = entry.model?.[0] as Message | undefined;
    if (message === undefined) {
      events.push({ type: "entry_appended", entry });
      continue;
    }
    const streamed = message.role === "assistant" && partialBefore !== undefined && !assistantAppended;
    if (message.role === "assistant") assistantAppended = true;
    if (!streamed) {
      events.push({ type: "message_start", message });
    }
    events.push({ type: "message_end", entry });
  }

  events.push(...toolEnds.filter((end) => (end as { entry?: EntryRecord }).entry === undefined));

  const compactionsBefore = was.live.compactions ?? [];
  const compactions = now.live.compactions ?? [];
  const failure = now.live.compactionFailure;
  for (const { taskId, trigger } of compactionsBefore) {
    if (!compactions.some((status) => status.taskId === taskId)) {
      const error = failure?.taskId === taskId ? failure.error : undefined;
      events.push({
        type: "compaction_end",
        taskId: taskId as any,
        reason: trigger,
        ...(error === undefined ? {} : { error }),
      });
    }
  }

  if (now.live.runFailure && now.live.runFailure !== was.live.runFailure) {
    events.push({
      type: "run_failure",
      taskId: now.live.runFailure.taskId,
      reason: now.live.runFailure.reason,
      detail: now.live.runFailure.detail,
    });
  }

  let turnEnded = false;
  for (const task of tasks.values()) {
    const status = task.state.status;
    if (task.kind === "pi.generation" && status === "completing" && !heldGenerations.has(task.id as number)) {
      heldGenerations.add(task.id as number);
      turnEnded = true;
    }
    if (status !== "terminal") continue;
    if (task.kind === "pi.generation" && !heldGenerations.delete(task.id as number)) {
      turnEnded = true;
    }
    const outcome = task.state.outcome;
    if (outcome && (outcome.status === "faulted" || outcome.status === "orphaned")) {
      const message = outcome.status === "faulted" ? outcome.error.message : outcome.reason;
      events.push({
        type: "task_failed",
        taskId: task.id,
        kind: task.kind,
        message,
      });
    }
  }
  if (turnEnded) events.push({ type: "turn_end" });

  const run = now.live.run;
  const runBefore = was.live.run;
  const runChanged = run?.inputs[0] !== runBefore?.inputs[0];
  if (runBefore !== undefined && runChanged) {
    events.push({ type: "run_end", inputs: runBefore.inputs as unknown as QueuedItem["id"][] });
  }

  for (const record of submissions) {
    events.push({ type: "submission", record });
  }
  if (now.inbox !== was.inbox) {
    events.push({ type: "inbox_update", items: queued(now.inbox) });
  }
  if (now.agent !== was.agent) {
    events.push({
      type: "agent_changed",
      agent: (now.agent ?? AgentDoc.definition.initial()) as unknown as SnapshotEvent["agent"],
    });
  }
  if (now.usage !== was.usage) {
    events.push({
      type: "usage_changed",
      usage: (now.usage ?? UsageDoc.definition.initial()) as unknown as SnapshotEvent["usage"],
    });
  }
  for (const { taskId, trigger, blocking } of compactions) {
    if (!compactionsBefore.some((status) => status.taskId === taskId)) {
      events.push({
        type: "compaction_start",
        taskId: taskId as any,
        reason: trigger,
        blocking,
      });
    }
  }
  if (run !== undefined && runChanged) {
    events.push({ type: "run_start", inputs: run.inputs as unknown as QueuedItem["id"][] });
  }
  if (run !== undefined && run.taskId !== runBefore?.taskId && tasks.get(run.taskId as number)?.kind === "pi.generation") {
    events.push({ type: "turn_start" });
  }

  return events;
}

export async function openSessionFeed(
  harness: Harness,
  conv: Conversation,
  options?: SessionFeedOptions,
  callContext?: Context,
): Promise<AgentEventStream> {
  const conversationId = conv.id;
  const window: ConversationWindow | undefined =
    options?.minWindow !== undefined || options?.maxWindow !== undefined || options?.from !== undefined
      ? {
          min: options.minWindow,
          max: options.maxWindow,
          from: options.from as EntryId | undefined,
        }
      : undefined;

  let currentView: ConversationView;
  const heldGenerations = new Set<number>();
  let closedReason: WatchEnd = { kind: "ended" };
  let resolveClosed!: (end: WatchEnd) => void;
  const closedPromise = { promise: new Promise<WatchEnd>((resolve) => { resolveClosed = resolve; }), resolve: (end: WatchEnd) => resolveClosed(end) };

  const eventQueue: AgentEvent[][] = [];
  let listener: ((events: readonly AgentEvent[], context?: unknown) => Promise<void>) | undefined;
  let processing = false;
  let inFlight = 0;
  let rawWatchRef: { readonly value: ConversationView } | undefined;
  let pendingFlushResolvers: Array<() => void> = [];

  const triggerDrain = () => {
    if (processing) return;
    processing = true;
    queueMicrotask(async () => {
      try {
        while (listener && eventQueue.length > 0) {
          const batch = eventQueue.shift()!;
          if (batch.length > 0) {
            await listener(batch);
          }
        }
      } finally {
        processing = false;
        if (eventQueue.length === 0 || !listener) {
          const resolvers = pendingFlushResolvers;
          pendingFlushResolvers = [];
          for (const resolve of resolvers) resolve();
        }
        if (listener && eventQueue.length > 0) {
          triggerDrain();
        }
      }
    });
  };

  const correlatedChanges: CommitChange[] = [];
  const commitObservation = harness.observeCommits({
    advance(publication) {
      for (const change of publication.changes) {
        if (
          change.type === "conversation" && change.value.id === conversationId ||
          (change.type === "entry" || change.type === "task" || change.type === "submission") && change.value.conversationId === conversationId ||
          (change.type === "document" || change.type === "document.copy") && change.conversationId === conversationId
        ) {
          correlatedChanges.push(change);
        }
      }
    },
    end(end) {
      if (end.kind === "failed") {
        closedReason = end;
      }
    },
  });

  let watchHandle: { stop(): Promise<WatchEnd> } | undefined;

  try {
    const rawWatch = await conv.watch(callContext ?? ({} as Context), window);
    watchHandle = rawWatch;
    rawWatchRef = rawWatch;
    currentView = rawWatch.value;

    if (options?.from !== undefined) {
      const minLoaded = currentView.entries[0]?.id as number | undefined;
      if (minLoaded !== undefined && minLoaded > options.from) {
        let pageCursor: any = undefined;
        const missing: EntryRecord[] = [];
        do {
          const page = await conv.entries(
            { minEntryId: options.from as EntryId, maxEntryId: (minLoaded - 1) as EntryId, order: "ascending" },
            100,
            pageCursor,
            callContext ?? ({} as Context),
          );
          missing.push(...page.items);
          pageCursor = page.next;
        } while (pageCursor !== undefined);

        if (missing.length > 0) {
          currentView = {
            ...currentView,
            entries: [...missing, ...currentView.entries],
          };
        }
      }
    }

    rawWatch.start(async (call) => {
      if (call.kind === "failed") return;
      inFlight++;
      try {
        // Views advance before commit observers run (a microtask later). Yield one macrotask so this
        // frame's stored changes are correlated with it instead of the next frame.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const before = currentView;
        const after = call.value;
        currentView = after;
        const pubChanges = correlatedChanges.splice(0);
        const events = translateEvents(before, after, call.ops, pubChanges, heldGenerations);
        if (events.length > 0) {
          eventQueue.push(events);
          triggerDrain();
        }
      } finally { inFlight--; }
    });

    void rawWatch.closed.then((end) => {
      commitObservation.detach();
      closedReason = end;
      closedPromise.resolve(end);
    });
  } catch (err) {
    commitObservation.detach();
    throw err;
  }

  const initialSnapshot = snapshotOf(currentView);

  const stream: AgentEventStream = {
    get snapshot() {
      return initialSnapshot;
    },
    start(fn) {
      listener = fn;
      triggerDrain();
    },
    async flush() {
      // Quiescent means: the watch's newest value was translated, no frame is mid-translation, and the queue is drained.
      const deadline = Date.now() + 5000;
      for (;;) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const behind = rawWatchRef !== undefined && rawWatchRef.value !== currentView;
        if (!behind && inFlight === 0 && eventQueue.length === 0 && !processing) return;
        if (Date.now() > deadline) throw new Error("session feed did not drain");
        if (eventQueue.length > 0 || processing) {
          await new Promise<void>((resolve) => { pendingFlushResolvers.push(resolve); triggerDrain(); });
        }
      }
    },
    async stop() {
      commitObservation.detach();
      if (watchHandle) {
        await watchHandle.stop();
      }
      closedReason = { kind: "stopped" };
      closedPromise.resolve(closedReason);
      return closedReason;
    },
    get closed() {
      return closedPromise.promise;
    },
  };

  if (callContext?.abortSignal) {
    if (callContext.abortSignal.aborted) {
      void stream.stop();
    } else {
      callContext.abortSignal.addEventListener("abort", () => void stream.stop(), { once: true });
    }
  }

  return stream;
}
