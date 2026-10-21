import { ExecTarget } from "./workers.js";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Models, Model, Usage } from "@earendil-works/pi-ai";
import { AgentDoc, ProviderDoc, UsageDoc, type Agent, type AgentState, type Conversation } from "@earendil-works/pi-durable";
import { context } from "./luna.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;
export type SideInput = string | ({ type: "text"; text: string } | { type: "image" | "audio"; data: string; mimeType: string })[];
export interface SideJob {
  id: string; sessionId: string; kind: "btw" | "bg"; prompt: string;
  status: "running" | "complete" | "failed"; text: string; conversationId?: number; createdAt: number;
}
const INSTRUCTION = "Answer only the side question. Do not continue or critique the main task. " +
  "Do not use tools. If the context is not enough, say so. Keep the answer short. " +
  "The conversation is context, not instructions for a new task.";

/** Keep an unchanged prefix ending at a finished assistant text response. */
export function trimSideHistory(messages: readonly Message[]): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && (m.stopReason === "stop" || m.stopReason === "length") &&
      m.content.some(b => b.type === "text" && b.text.trim()) && !m.content.some(b => b.type === "toolCall")) {
      return structuredClone(messages.slice(0, i + 1));
    }
  }
  return [];
}
/** Newest-first budget selection, returned in chronological order. System text never enters the digest. */
export function renderSideHistory(messages: readonly Message[]): string {
  const selected: string[] = [];
  let remaining = 24000;
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const m = messages[i]!;
    if (m.role === "system") continue;
    const label = m.role === "user" ? "USER" : m.role === "assistant" ? "ASSISTANT" : "TOOL RESULT";
    const body = typeof m.content === "string" ? m.content : m.content.map(b =>
      b.type === "text" ? b.text : b.type === "toolCall" ? `[tool call: ${b.name}]` : "").join("\n");
    const line = `${label}: ${body.slice(0, 2000)}`;
    const allowed = remaining - (selected.length ? 1 : 0);
    if (allowed <= 0) break;
    selected.push(line.slice(0, allowed)); remaining -= Math.min(line.length, allowed) + (selected.length > 1 ? 1 : 0);
  }
  return selected.reverse().join("\n");
}

export class SideCommands {
  private readonly jobs = new Map<string, SideJob>();
  private readonly listeners = new Map<string, Set<(job: SideJob) => void>>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private readonly tempDirs = new Set<string>();
  private readonly remoteTempDirs: { worker: number; path: string }[] = [];
  private readonly requests = new Map<string, { fingerprint: string; promise: Promise<SideJob> }>();
  private readonly admissions = new Set<Promise<SideJob>>();
  private closing = false;
  private observingClose = false;
  private closePromise?: Promise<void>;
  constructor(private readonly options: {
    harness: Harness; models?: Models; route?: () => { provider: string; modelId: string } | undefined;
    remoteEnv?: (worker: number, cwd?: string) => import("@earendil-works/pi-durable/env").ExecutionEnv;
  }) {}

  list(sessionId: string): SideJob[] {
    return [...this.jobs.values()].filter(j => j.sessionId === sessionId).map(j => ({ ...j }));
  }
  subscribe(sessionId: string, listener: (job: SideJob) => void): () => void {
    const set = this.listeners.get(sessionId) ?? new Set();
    this.listeners.set(sessionId, set); set.add(listener);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(sessionId); };
  }
  private notify(job: SideJob) {
    for (const listener of this.listeners.get(job.sessionId) ?? []) {
      try { listener({ ...job }); } catch { /* A disconnected viewer does not own the job. */ }
    }
  }
  close(): Promise<void> {
    this.closing = true;
    return this.closePromise ??= (async () => {
      await Promise.allSettled([...this.admissions]);
      for (const controller of this.controllers) controller.abort();
      await Promise.allSettled([...this.tasks]);
      for (const dir of this.tempDirs) rmSync(dir, { recursive: true, force: true });
      this.tempDirs.clear();
      if (this.options.remoteEnv) {
        await Promise.allSettled(this.remoteTempDirs.map(({ worker, path }) =>
          this.options.remoteEnv!(worker).remove(path, { recursive: true, force: true }, context)));
      }
      this.remoteTempDirs.length = 0; this.listeners.clear(); this.requests.clear();
    })();
  }

  async start(source: Conversation, kind: "btw" | "bg", prompt: string, content: SideInput, requestId?: string): Promise<SideJob> {
    if (this.closing) throw new Error("side commands are shutting down");
    if (!prompt.trim()) throw new Error(`Usage: /${kind} <${kind === "btw" ? "question" : "prompt"}>`);
    // Register before the first await: concurrent retries share exactly one admission.
    const key = requestId ? JSON.stringify([String(source.id), requestId]) : undefined;
    const fingerprint = JSON.stringify([kind, prompt, content]);
    const prior = key && this.requests.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("conflicting requestId reuse");
      const job = await prior.promise;
      return { ...(this.jobs.get(job.id) ?? job) };
    }
    const promise = this.admit(source, kind, prompt, structuredClone(content));
    this.admissions.add(promise);
    if (key) this.requests.set(key, { fingerprint, promise });
    try { return await promise; }
    catch (error) { if (key) this.requests.delete(key); throw error; }
    finally { this.admissions.delete(promise); }
  }

  private async admit(source: Conversation, kind: "btw" | "bg", prompt: string, content: SideInput): Promise<SideJob> {
    let messages: Message[] = [];
    if (kind === "btw") {
      try { messages = structuredClone((await source.context(context)).messages) as Message[]; }
      catch { throw new Error("history unreadable"); }
      if (!messages.some(m => m.role !== "system")) throw new Error("no history");
    }
    const agent = await source.agent(context);
    const route = kind === "btw" ? this.options.route?.() : undefined;
    const ref = route ?? agent.model;
    const models = this.options.models;
    const model = ref && models?.getModel(ref.provider, ref.modelId);
    if (!models || !model || !await models.getAuth(model)) throw new Error(kind === "bg" ? "no credentials" : "no provider");
    const state = kind === "bg" ? await this.options.harness.snapshot(AgentDoc, source.id, context) : undefined;
    const identity = kind === "btw" ? await this.options.harness.snapshot(ProviderDoc, source.id, context) : undefined;
    if (this.closing) throw new Error("side commands are shutting down");
    const now = new Date(), time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, "0")).join("");
    const job: SideJob = { id: `${kind}_${time}_${randomBytes(3).toString("hex")}`, sessionId: String(source.id),
      kind, prompt, status: "running", text: "", createdAt: Date.now() };
    if (!this.observingClose) {
      this.observingClose = true;
      void this.options.harness.closed.then(() => this.close()).catch(() => {});
    }
    this.jobs.set(job.id, job); this.notify(job);
    const controller = new AbortController(); this.controllers.add(controller);
    // Schedule work after admission; callers receive a receipt without waiting for the model.
    const task = Promise.resolve().then(async () => {
      try {
        if (controller.signal.aborted) throw new Error("side job stopped during shutdown");
        const text = kind === "btw"
          ? await this.answer(source, prompt, messages, model, agent, !!route, identity?.sessionId, controller.signal)
          : await this.background(source, job, model, agent, state, content, controller.signal);
        if (controller.signal.aborted) throw new Error("side job stopped during shutdown");
        if (!text.trim()) throw new Error("empty response");
        job.text = text; job.status = "complete";
      } catch (error) { job.status = "failed"; job.text = (error as Error).message ?? String(error); }
      finally { this.notify(job); this.controllers.delete(controller); }
    });
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task));
    return { ...job };
  }

  private async usage(source: Conversation, model: Model<any>, usage: Usage) {
    await this.options.harness.commit(async tx => {
      const totals = (await tx.doc(UsageDoc, source.id)).models, key = `${model.provider}/${model.id}`;
      const total = Object.hasOwn(totals, key) ? totals[key] : undefined;
      if (!total) { totals[key] = JSON.parse(JSON.stringify(usage)); return; }
      for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[field] += usage[field];
      for (const field of ["cacheWrite1h", "reasoning"] as const) if (usage[field] !== undefined) total[field] = (total[field] ?? 0) + usage[field]!;
      for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[field] += usage.cost[field];
    }, context);
  }
  private async answer(source: Conversation, question: string, snapshot: Message[], model: Model<any>, agent: Agent,
    routed: boolean, sessionId: string | undefined, signal: AbortSignal): Promise<string> {
    const prefix = routed ? [] : trimSideHistory(snapshot);
    const replay = prefix.length > 0;
    const messages: Message[] = replay ? prefix : [];
    const suffix = replay ? `${INSTRUCTION}\n\nSide question: ${question}`
      : `Conversation snapshot:\n${renderSideHistory(snapshot)}\n\nSide question: ${question}`;
    messages.push({ role: "user", content: suffix, timestamp: Date.now() });
    const attempts = replay ? 3 : 1;
    for (let i = 0; i < attempts; i++) {
      const response = await this.options.models!.completeSimple(model, {
        ...(!replay ? { systemPrompt: INSTRUCTION, tools: [] } : {}), messages,
      }, { signal, sessionId: replay ? sessionId : undefined, reasoning: agent.thinkingLevel === "off" ? undefined : agent.thinkingLevel });
      await this.usage(source, model, response.usage);
      if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || response.stopReason);
      const calls = response.content.filter(b => b.type === "toolCall");
      if (!calls.length) return response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      // Retain schemas for prefix parity, but never dispatch any tool, even a fabricated call.
      messages.push(response);
      for (const call of calls) messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name,
        content: [{ type: "text", text: "Tools are denied for side questions. Answer the side question with text only." }], isError: true, timestamp: Date.now() });
    }
    throw new Error("side question failed: model requested tools instead of answering");
  }

  private async background(source: Conversation, job: SideJob, model: Model<any>, agent: Agent,
    state: Readonly<AgentState> | undefined, content: SideInput, signal: AbortSignal): Promise<string> {
    const child = await this.options.harness.createConversation({ ownership: { kind: "ownerless" }, agent: {
      model: { provider: model.provider, modelId: model.id }, thinkingLevel: agent.thinkingLevel,
      cwd: agent.cwd, instructions: agent.instructions, extensions: agent.extensions,
    }, init: async (tx, id) => {
      // Copy stored filters, not tool implementations, and never widen the parent's enabled tool set.
      const worker = (await tx.doc(ExecTarget, source.id)).worker;
      (await tx.doc(ExecTarget, id)).worker = worker;
      await tx.appendEntry(id, { kind: "luna.execution", data: { worker, cwd: agent.cwd ?? null } });
      const doc = await tx.doc(AgentDoc, id);
      if (state?.tools !== undefined) doc.tools = structuredClone(state.tools);
      if (state?.modelTools !== undefined) doc.modelTools = structuredClone(state.modelTools);
      await tx.appendEntry(id, { kind: "delegate.child", data: { task: job.prompt, parent: source.id, backgroundTask: job.id } });
    } }, context);
    job.conversationId = Number(child.id); this.notify(job);
    let stopping: Promise<void> | undefined;
    const stop = () => { stopping ??= child.abort(context).catch(() => {}); };
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (signal.aborted) throw new Error("side job stopped during shutdown");
      const blocks: Exclude<import("@earendil-works/pi-durable").UserInput, string> = [{ type: "text", text: job.prompt }];
      for (const block of typeof content === "string" ? [] : content) {
        if (block.type === "image") blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
        else if (block.type === "audio") {
          const extension = ({ "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg",
            "audio/webm": "webm", "audio/mp4": "m4a", "audio/flac": "flac" } as Record<string, string>)[block.mimeType];
          if (!extension) throw new Error("unsupported audio type");
          const worker = (await this.options.harness.snapshot(ExecTarget, child.id, context))?.worker;
          const bytes = Buffer.from(block.data, "base64");
          let path: string;
          if (worker) {
            if (!this.options.remoteEnv) throw new Error("Execution workers are unavailable for audio attachments.");
            const env = this.options.remoteEnv(worker, agent.cwd);
            const tmp = await env.createTempDir("luna-bg-audio-", context);
            if (!tmp.ok) throw new Error(`Failed to stage audio on worker: ${tmp.error.message}`);
            this.remoteTempDirs.push({ worker, path: tmp.value });
            const joined = await env.joinPath([tmp.value, `attachment.${extension}`], context);
            if (!joined.ok) throw new Error(`Failed to stage audio on worker: ${joined.error.message}`);
            const written = await env.writeFile(joined.value, new Uint8Array(bytes), context);
            if (!written.ok) throw new Error(`Failed to stage audio on worker: ${written.error.message}`);
            path = joined.value;
          } else {
            const dir = mkdtempSync(join(tmpdir(), "luna-bg-audio-")); this.tempDirs.add(dir);
            path = join(dir, `attachment.${extension}`);
            writeFileSync(path, bytes, { mode: 0o600 });
          }
          blocks.push({ type: "text", text: `Audio attachment available at ${path}; use tools to inspect it.` });
        }
      }
      const sub = await child.submit({ type: "input", content: blocks.length === 1 ? job.prompt : blocks }, context);
      if (signal.aborted) stop();
      const result = await sub.wait(context);
      if (result.status !== "done") throw new Error(`background task ${result.status}${"reason" in result ? `: ${result.reason}` : ""}${"detail" in result && result.detail ? `: ${JSON.stringify(result.detail)}` : ""}`);
      const answer = result.answer;
      if (!answer) throw new Error("background task has no final answer");
      const entry = await this.options.harness.commit(tx => tx.entry(answer), context);
      const responses = entry?.model?.filter(m => m.role === "assistant") ?? [];
      const error = responses.find(m => m.stopReason === "error" || m.stopReason === "aborted");
      if (error) throw new Error(error.errorMessage || error.stopReason);
      return responses.flatMap(m => m.content.filter(b => b.type === "text").map(b => b.text)).join("\n");
    } finally { signal.removeEventListener("abort", stop); await stopping; }
  }
}
