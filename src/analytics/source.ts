import type { Database } from "bun:sqlite";
import { apply, type Op } from "@earendil-works/chord/delta";
import type { AnalyticsMetrics } from "../analytics.js";
import type {
  AnalyticsFact,
  AnalyticsScan,
  AnalyticsSessionRecord,
} from "./types.js";

function emptyMetrics(): AnalyticsMetrics {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    reasoning: null,
    cacheWrite1h: null,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cacheHitRate: null,
  };
}

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;

function addUsage(target: AnalyticsMetrics, u: Record<string, unknown> | null | undefined): void {
  if (!u || typeof u !== "object") return;
  target.input += num(u.input);
  target.output += num(u.output);
  target.cacheRead += num(u.cacheRead);
  target.cacheWrite += num(u.cacheWrite);
  target.totalTokens += num(u.totalTokens);
  if (typeof u.reasoning === "number" && Number.isFinite(u.reasoning) && u.reasoning >= 0) {
    target.reasoning = (target.reasoning ?? 0) + u.reasoning;
  }
  if (typeof u.cacheWrite1h === "number" && Number.isFinite(u.cacheWrite1h) && u.cacheWrite1h >= 0) {
    target.cacheWrite1h = (target.cacheWrite1h ?? 0) + u.cacheWrite1h;
  }
  const cost = u.cost as Record<string, unknown> | undefined;
  if (cost && typeof cost === "object") {
    target.cost.input += num(cost.input);
    target.cost.output += num(cost.output);
    target.cost.cacheRead += num(cost.cacheRead);
    target.cost.cacheWrite += num(cost.cacheWrite);
    target.cost.total += num(cost.total);
  }
  const denom = target.input + target.cacheRead + target.cacheWrite;
  target.cacheHitRate = denom > 0 ? target.cacheRead / denom : null;
}

function toPartialMetrics(u: Record<string, unknown> | null | undefined): Partial<AnalyticsMetrics> | null {
  if (!u || typeof u !== "object") return null;
  const m = emptyMetrics();
  addUsage(m, u);
  return m;
}

function sanitizeError(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let s = raw
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{10,})\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  if (s.length > 300) s = s.slice(0, 297) + "...";
  return s;
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(name) as { ok: number } | null;
  return Boolean(row?.ok);
}

function reconstructDoc(db: Database, docId: number): unknown {
  const revs = db
    .query(
      `SELECT seq, kind, content FROM document_revisions
       WHERE document_id = ? AND seq >= COALESCE((SELECT MAX(seq) FROM document_revisions WHERE document_id = ? AND kind = 'base'), 0)
       ORDER BY seq ASC`,
    )
    .all(docId, docId) as { seq: number; kind: "base" | "delta"; content: string }[];
  if (revs.length === 0 || revs[0]!.kind !== "base") return undefined;
  let value: unknown = JSON.parse(revs[0]!.content);
  for (let i = 1; i < revs.length; i++) {
    const rev = revs[i]!;
    if (rev.kind === "delta") {
      const ops = JSON.parse(rev.content) as Op[];
      value = apply(value, ops);
    }
  }
  return value;
}

function readCurrentDoc(
  db: Database,
  kind: string,
  scopeKind: "conversation" | "session" | "task",
  ownerId: number,
): unknown {
  const row = db
    .query(
      "SELECT id FROM documents WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND retired_at IS NULL ORDER BY id DESC LIMIT 1",
    )
    .get(JSON.stringify(kind), scopeKind, ownerId) as { id: number } | null;
  if (!row) return undefined;
  return reconstructDoc(db, row.id);
}

function computeForkDepth(db: Database, startParentId: number | null): number {
  let depth = 0;
  let cur = startParentId;
  const seen = new Set<number>();
  while (cur !== null && depth < 32) {
    if (seen.has(cur)) break;
    seen.add(cur);
    depth++;
    const row = db
      .query("SELECT record FROM conversations WHERE id = ?")
      .get(cur) as { record: string } | null;
    if (!row) break;
    try {
      const parsed = JSON.parse(row.record) as { parent?: { conversationId?: number | string } };
      const pid = parsed.parent?.conversationId;
      cur = pid != null && Number.isFinite(Number(pid)) ? Number(pid) : null;
    } catch {
      cur = null;
    }
  }
  return depth;
}

function extractEntryTs(record: Record<string, unknown>): number | null {
  if (typeof record.timestamp === "number" && Number.isFinite(record.timestamp)) return record.timestamp;
  if (typeof record.ts === "number" && Number.isFinite(record.ts)) return record.ts;
  if (typeof record.at === "number" && Number.isFinite(record.at)) return record.at;
  const model = record.model;
  if (Array.isArray(model)) {
    for (let i = model.length - 1; i >= 0; i--) {
      const m = model[i] as Record<string, unknown> | undefined;
      if (m && typeof m.timestamp === "number" && Number.isFinite(m.timestamp)) return m.timestamp;
    }
  } else if (model && typeof model === "object") {
    const m = model as Record<string, unknown>;
    if (typeof m.timestamp === "number" && Number.isFinite(m.timestamp)) return m.timestamp;
  }
  return null;
}

function collectUploadIds(val: unknown, out: Set<string>): void {
  if (typeof val === "string") {
    const matches = val.matchAll(/\/v1\/uploads\/([A-Za-z0-9_-]+)/g);
    for (const m of matches) {
      if (m[1]) out.add(m[1]);
    }
    return;
  }
  if (Array.isArray(val)) {
    for (const item of val) collectUploadIds(item, out);
    return;
  }
  if (val && typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if (typeof obj.uploadId === "string" && obj.uploadId) out.add(obj.uploadId);
    if (typeof obj.attachmentId === "string" && obj.attachmentId) out.add(obj.attachmentId);
    for (const v of Object.values(obj)) {
      if (typeof v === "string" || typeof v === "object") collectUploadIds(v, out);
    }
  }
}

export function scanAnalyticsSession(
  db: Database,
  id: number,
  previous?: AnalyticsSessionRecord,
): AnalyticsScan | undefined {
  const conv = db
    .query("SELECT id, owner_conversation_id, owner_task_id, record FROM conversations WHERE id = ?")
    .get(id) as {
    id: number;
    owner_conversation_id: number | null;
    owner_task_id: number | null;
    record: string;
  } | null;
  if (!conv) return undefined;

  // Determine structural revision and whether we can do incremental append
  const stats = db
    .query(
      "SELECT MIN(id) AS minId, MAX(id) AS maxId, COUNT(*) AS cnt, MAX(commit_seq) AS maxSeq FROM entries WHERE conversation_id = ?",
    )
    .get(id) as { minId: number | null; maxId: number | null; cnt: number; maxSeq: number | null };

  const currentRevision = `${stats.minId ?? 0}:${stats.cnt}:${stats.maxSeq ?? 0}`;
  let rebuild = true;

  if (previous && previous.revision !== "") {
    if (previous.lastEntryId === 0) {
      rebuild = false;
    } else if ((stats.maxId ?? 0) >= previous.lastEntryId) {
      const prevStats = db
        .query(
          "SELECT MIN(id) AS minId, COUNT(*) AS cnt, MAX(commit_seq) AS maxSeq FROM entries WHERE conversation_id = ? AND id <= ?",
        )
        .get(id, previous.lastEntryId) as { minId: number | null; cnt: number; maxSeq: number | null };
      const prevMarker = `${prevStats.minId ?? 0}:${prevStats.cnt}:${prevStats.maxSeq ?? 0}`;
      if (prevMarker === previous.revision) {
        const undoInTail = db
          .query(
            "SELECT 1 AS ok FROM entries WHERE conversation_id = ? AND id > ? AND json_extract(record, '$.kind') = 'luna.undo' LIMIT 1",
          )
          .get(id, previous.lastEntryId) as { ok: number } | null;
        if (!undoInTail) rebuild = false;
      }
    }
  }

  const entryRows = rebuild
    ? (db
        .query("SELECT id, head, commit_seq, record FROM entries WHERE conversation_id = ? ORDER BY id ASC")
        .all(id) as { id: number; head: number | null; commit_seq: number; record: string }[])
    : (db
        .query("SELECT id, head, commit_seq, record FROM entries WHERE conversation_id = ? AND id > ? ORDER BY id ASC")
        .all(id, previous!.lastEntryId) as { id: number; head: number | null; commit_seq: number; record: string }[]);

  let userTurns = rebuild ? 0 : previous!.userTurns;
  let assistantTurns = rebuild ? 0 : previous!.assistantTurns;
  let lastActivity: number | null = rebuild ? null : previous!.lastActivity;
  let lastEntryId = rebuild ? 0 : previous!.lastEntryId;
  let execCwd: string | null = rebuild ? null : previous!.cwd;

  const facts: AnalyticsFact[] = [];
  const pendingTools = new Map<
    string,
    {
      toolCallId: string;
      name: string;
      ts: number | null;
      model: string | null;
      skillName?: string;
      skillFilePath?: string | null;
      isSessionStatus?: boolean;
      waitStatus?: string | null;
      waitResolvedTs?: number | null;
    }
  >();
  const toolResults = new Map<string, { ts: number | null; durationMs: number | null; isError: boolean }>();
  const referencedUploadIds = new Set<string>();
  const metadataWaits = new Map<
    string,
    {
      callId: string;
      startedAt: number | null;
      endedAt: number | null;
      purpose: string | null;
      tool: string;
      outcome: string | null;
      durationMs: number | null;
    }
  >();

  for (const row of entryRows) {
    if (row.id > lastEntryId) lastEntryId = row.id;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(row.record) as Record<string, unknown>;
    } catch {
      continue;
    }
    const kind = typeof rec.kind === "string" ? rec.kind : "";
    const ts = extractEntryTs(rec);

    collectUploadIds(rec, referencedUploadIds);

    if (kind === "luna.analytics.wait") {
      const d = (rec.data && typeof rec.data === "object" ? rec.data : {}) as Record<string, unknown>;
      const callId = typeof d.callId === "string" ? d.callId : null;
      if (callId) {
        const startedAt = typeof d.startedAt === "number" ? d.startedAt : ts;
        const endedAt = typeof d.endedAt === "number" ? d.endedAt : null;
        const purpose = typeof d.purpose === "string" ? d.purpose : null;
        const tool = typeof d.tool === "string" ? d.tool : "wait";
        const outcome = typeof d.outcome === "string" ? d.outcome : null;
        const durationMs = startedAt !== null && endedAt !== null && endedAt >= startedAt ? endedAt - startedAt : null;
        metadataWaits.set(callId, {
          callId,
          startedAt,
          endedAt,
          purpose,
          tool,
          outcome,
          durationMs,
        });
      }
    } else if (kind === "pi.user") {
      userTurns++;
      if (ts !== null && (lastActivity === null || ts > lastActivity)) {
        lastActivity = ts;
      }
      for (const [callId, info] of pendingTools) {
        if (info.isSessionStatus && info.ts !== null && ts !== null && ts >= info.ts) {
          const res = toolResults.get(callId);
          const startTs = res?.ts ?? info.ts;
          if (ts >= startTs) {
            info.waitResolvedTs = ts;
          }
        }
      }
    } else if (kind === "pi.assistant") {
      assistantTurns++;
      const modelArr = Array.isArray(rec.model) ? rec.model : [rec.model];
      const msg = (modelArr[0] ?? {}) as Record<string, unknown>;
      const msgTs = typeof msg.timestamp === "number" ? msg.timestamp : ts;
      if (msgTs !== null && (lastActivity === null || msgTs > lastActivity)) {
        lastActivity = msgTs;
      }
      const provider = typeof msg.provider === "string" ? msg.provider : null;
      const modelName = typeof msg.model === "string" ? msg.model : null;
      const fullModel = provider && modelName ? `${provider}/${modelName}` : modelName;
      const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : null;
      const aborted = stopReason === "aborted";
      const errorMsg = sanitizeError(msg.errorMessage);
      const isError = stopReason === "error" || errorMsg !== null;
      const durationMs =
        typeof msg.durationMs === "number" && Number.isFinite(msg.durationMs) ? msg.durationMs : null;

      let thinkingChars = 0;
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "thinking" && typeof b.thinking === "string") {
          thinkingChars += b.thinking.length;
        } else if (b.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string") {
          const args = (b.arguments && typeof b.arguments === "object" ? b.arguments : {}) as Record<string, unknown>;
          const info: {
            toolCallId: string;
            name: string;
            ts: number | null;
            model: string | null;
            skillName?: string;
            skillFilePath?: string | null;
            isSessionStatus?: boolean;
            waitStatus?: string | null;
            waitResolvedTs?: number | null;
          } = {
            toolCallId: b.id,
            name: b.name,
            ts: msgTs,
            model: fullModel,
          };
          if (b.name === "skill" && args.action === "view" && typeof args.name === "string") {
            info.skillName = args.name;
            info.skillFilePath = typeof args.file_path === "string" ? args.file_path : null;
          }
          if (b.name === "session_status" || b.name === "ask_user_question") {
            info.isSessionStatus = true;
            info.waitStatus = b.name === "ask_user_question" ? "ask_user_question" : typeof args.status === "string" ? args.status : null;
          }
          pendingTools.set(b.id, info);
        }
      }

      const servedModel = typeof msg.responseModel === "string" ? msg.responseModel : null;
      const thinkingLevel = typeof msg.thinkingLevel === "string" ? msg.thinkingLevel : null;
      const providerThinkingLevel = typeof msg.providerThinkingLevel === "string" ? msg.providerThinkingLevel : null;
      const msgUsage = msg.usage as Record<string, unknown> | undefined;
      facts.push({
        key: `response:${row.id}`,
        sessionId: id,
        kind: "response",
        ts: msgTs,
        name: fullModel,
        model: fullModel,
        source: null,
        durationMs,
        error: isError,
        aborted,
        data: {
          stopReason,
          thinkingChars,
          errorMessage: errorMsg,
          requestedModel: fullModel,
          servedModel,
          thinkingLevel,
          providerThinkingLevel,
          cacheRead: num(msgUsage?.cacheRead),
          cacheWrite: num(msgUsage?.cacheWrite),
          outputTokens: num(msgUsage?.output),
        },
        usage: toPartialMetrics(msgUsage),
      });
    } else if (kind === "pi.tool-result") {
      const modelArr = Array.isArray(rec.model) ? rec.model : [rec.model];
      const msg = (modelArr[0] ?? {}) as Record<string, unknown>;
      const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : null;
      if (toolCallId) {
        const isError = Boolean(msg.isError);
        const msgTs = typeof msg.timestamp === "number" ? msg.timestamp : ts;
        const durationMs =
          typeof msg.durationMs === "number" && Number.isFinite(msg.durationMs) ? msg.durationMs : null;
        toolResults.set(toolCallId, { ts: msgTs, durationMs, isError });
      }
    } else if (kind === "luna.execution") {
      const data = rec.data as Record<string, unknown> | undefined;
      if (data && typeof data.cwd === "string" && data.cwd) {
        execCwd = data.cwd;
      }
    } else if (kind === "pi.system") {
      const modelArr = Array.isArray(rec.model) ? rec.model : [rec.model];
      let chars = 0;
      for (const m of modelArr) {
        if (!m || typeof m !== "object") continue;
        const c = (m as Record<string, unknown>).content;
        if (typeof c === "string") {
          chars += c.length;
        } else if (Array.isArray(c)) {
          for (const block of c) {
            if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
              chars += ((block as Record<string, unknown>).text as string).length;
            }
          }
        }
      }
      facts.push({
        key: `system:${row.id}`,
        sessionId: id,
        kind: "system",
        ts,
        name: "system",
        model: null,
        source: null,
        durationMs: null,
        error: false,
        aborted: false,
        data: { chars },
        usage: null,
      });
    } else if (kind === "pi.compaction") {
      const data = rec.data as Record<string, unknown> | undefined;
      const reason = typeof data?.reason === "string" ? data.reason : null;
      const modelArr = Array.isArray(rec.model) ? rec.model : [rec.model];
      let summaryChars = 0;
      for (const m of modelArr) {
        if (m && typeof m === "object" && typeof (m as Record<string, unknown>).content === "string") {
          summaryChars += ((m as Record<string, unknown>).content as string).length;
        }
      }
      facts.push({
        key: `compaction:${row.id}`,
        sessionId: id,
        kind: "compaction",
        ts,
        name: "compaction",
        model: null,
        source: null,
        durationMs: null,
        error: false,
        aborted: false,
        data: { reason, summaryChars },
        usage: null,
      });
    } else if (kind === "luna.model-changed") {
      const data = rec.data as Record<string, unknown> | undefined;
      const prevModel = typeof data?.previous === "string" ? data.previous : typeof data?.from === "string" ? data.from : null;
      const newModel = typeof data?.new === "string" ? data.new : typeof data?.to === "string" ? data.to : typeof data?.model === "string" ? data.model : typeof rec.model === "string" ? rec.model : null;
      facts.push({
        key: `model_switch:${row.id}`,
        sessionId: id,
        kind: "model_switch",
        ts,
        name: newModel,
        model: newModel,
        source: null,
        durationMs: null,
        error: false,
        aborted: false,
        data: { previous: prevModel, new: newModel },
        usage: null,
      });
    } else if (kind === "luna.undo") {
      facts.push({
        key: `undo:${row.id}`,
        sessionId: id,
        kind: "undo",
        ts,
        name: "undo",
        model: null,
        source: null,
        durationMs: null,
        error: false,
        aborted: false,
        data: {},
        usage: null,
      });
    } else if (kind === "delegate.child" || kind === "delegate.msg" || kind === "luna.xsession.msg") {
      const data = rec.data as Record<string, unknown> | undefined;
      let sourceSessionId: number | null = null;
      let targetSessionId: number | null = id;
      if (kind === "delegate.child") {
        sourceSessionId = typeof data?.parent === "number" ? data.parent : null;
        targetSessionId = id;
      } else if (kind === "luna.xsession.msg") {
        sourceSessionId = typeof data?.from === "number" ? data.from : null;
        targetSessionId = id;
      } else {
        sourceSessionId = typeof data?.from === "number" ? data.from : typeof data?.parent === "number" ? data.parent : null;
        targetSessionId = typeof data?.to === "number" ? data.to : typeof data?.childId === "number" ? data.childId : id;
      }
      facts.push({
        key: `delegation:${row.id}`,
        sessionId: id,
        kind: "delegation",
        ts,
        name: kind,
        model: null,
        source: null,
        durationMs: null,
        error: false,
        aborted: false,
        data: { kind, sourceSessionId, targetSessionId, outcome: null },
        usage: null,
      });
    }
  }

  // Resolve any late pi.tool-result whose pi.assistant was in an earlier scan
  for (const [callId] of toolResults) {
    if (pendingTools.has(callId)) continue;
    const origRow = db
      .query(
        `SELECT record FROM entries
         WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.assistant'
           AND EXISTS (
             SELECT 1 FROM json_each(json_extract(record, '$.model[0].content')) AS c
             WHERE json_extract(c.value, '$.type') = 'toolCall'
               AND json_extract(c.value, '$.id') = ?
           )
         ORDER BY id DESC LIMIT 1`,
      )
      .get(id, callId) as { record: string } | null;
    if (!origRow) continue;
    try {
      const orec = JSON.parse(origRow.record) as Record<string, unknown>;
      const oModelArr = Array.isArray(orec.model) ? orec.model : [orec.model];
      const oMsg = (oModelArr[0] ?? {}) as Record<string, unknown>;
      const provider = typeof oMsg.provider === "string" ? oMsg.provider : null;
      const modelName = typeof oMsg.model === "string" ? oMsg.model : null;
      const fullModel = provider && modelName ? `${provider}/${modelName}` : modelName;
      const msgTs = typeof oMsg.timestamp === "number" ? oMsg.timestamp : extractEntryTs(orec);
      const content = Array.isArray(oMsg.content) ? oMsg.content : [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "toolCall" && b.id === callId && typeof b.name === "string") {
          const args = (b.arguments && typeof b.arguments === "object" ? b.arguments : {}) as Record<string, unknown>;
          pendingTools.set(callId, {
            toolCallId: callId,
            name: b.name,
            ts: msgTs,
            model: fullModel,
            ...(b.name === "skill" && args.action === "view" && typeof args.name === "string"
              ? { skillName: args.name, skillFilePath: typeof args.file_path === "string" ? args.file_path : null }
              : {}),
            ...(b.name === "session_status" || b.name === "ask_user_question"
              ? {
                  isSessionStatus: true,
                  waitStatus:
                    b.name === "ask_user_question"
                      ? "ask_user_question"
                      : typeof args.status === "string"
                        ? args.status
                        : null,
                }
              : {}),
          });
          break;
        }
      }
    } catch {}
  }

  // Emit tool, skill, and wait facts for pending tool calls
  for (const [callId, info] of pendingTools) {
    const res = toolResults.get(callId);
    const durationMs = res?.durationMs ?? null;
    facts.push({
      key: `tool:${id}:${callId}`,
      sessionId: id,
      kind: "tool",
      ts: info.ts,
      name: info.name,
      model: info.model,
      source: "direct",
      durationMs,
      error: res?.isError ?? false,
      aborted: false,
      data: res?.isError ? { error: "tool_error" } : {},
      usage: null,
    });
    if (info.skillName) {
      facts.push({
        key: `skill:${id}:${callId}`,
        sessionId: id,
        kind: "skill",
        ts: info.ts,
        name: info.skillName,
        model: info.model,
        source: "direct",
        durationMs,
        error: res?.isError ?? false,
        aborted: false,
        data: { file_path: info.skillFilePath ?? null },
        usage: null,
      });
    }
    if (info.isSessionStatus && info.ts !== null) {
      const meta = metadataWaits.get(callId);
      if (!meta) {
        facts.push({
          key: `wait:${id}:${callId}`,
          sessionId: id,
          kind: "wait",
          ts: info.ts,
          name: info.waitStatus ?? "session_status",
          model: info.model,
          source: "direct",
          durationMs: null,
          error: res?.isError ?? false,
          aborted: false,
          data: {
            status: info.waitStatus ?? null,
          },
          usage: null,
        });
      }
    }
  }

  // Exact metadata wait events override inferred waits
  for (const [callId, waitMeta] of metadataWaits) {
    const info = pendingTools.get(callId);
    facts.push({
      key: `wait:${id}:${callId}`,
      sessionId: id,
      kind: "wait",
      ts: waitMeta.startedAt,
      name: waitMeta.purpose ?? info?.waitStatus ?? waitMeta.tool,
      model: info?.model ?? null,
      source: "direct",
      durationMs: waitMeta.durationMs,
      error: false,
      aborted: false,
      data: {
        callId: waitMeta.callId,
        startedAt: waitMeta.startedAt,
        endedAt: waitMeta.endedAt,
        purpose: waitMeta.purpose,
        tool: waitMeta.tool,
        outcome: waitMeta.outcome,
        status: info?.waitStatus ?? null,
      },
      usage: null,
    });
  }

  // Turn facts from tasks (pi.generation)
  const taskRows = db
    .query("SELECT id, kind, status, record FROM tasks WHERE conversation_id = ?")
    .all(id) as { id: number; kind: string; status: string; record: string }[];
  const taskIds: number[] = [];
  for (const t of taskRows) {
    taskIds.push(t.id);
    if (t.kind === JSON.stringify("pi.generation")) {
      try {
        const trec = JSON.parse(t.record) as Record<string, unknown>;
        const startedAt = typeof trec.startedAt === "number" ? trec.startedAt : null;
        const endedAt = typeof trec.endedAt === "number" ? trec.endedAt : null;
        const durationMs = startedAt !== null && endedAt !== null && endedAt >= startedAt ? endedAt - startedAt : null;
        facts.push({
          key: `turn:${t.id}`,
          sessionId: id,
          kind: "turn",
          ts: startedAt,
          name: "turn",
          model: null,
          source: null,
          durationMs,
          error: false,
          aborted: Boolean(trec.abortRequested),
          data: { status: t.status, startedAt, endedAt },
          usage: null,
        });
      } catch {}
    }
  }

  // Codemode nested tool calls via owning task (include retired docs so historical calls don't vanish)
  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => "?").join(",");
    const nestedDocs = db
      .query(
        `SELECT id, owner_id FROM documents WHERE kind = ? AND scope_kind = 'task' AND owner_id IN (${placeholders})`,
      )
      .all(JSON.stringify("pi.tool.nested-call"), ...taskIds) as { id: number; owner_id: number }[];
    for (const nd of nestedDocs) {
      const doc = reconstructDoc(db, nd.id) as { taskId?: number; result?: { isError?: boolean; durationMs?: number } } | undefined;
      if (!doc || typeof doc !== "object" || typeof doc.taskId !== "number") continue;
      const pointedTask = db
        .query("SELECT record FROM tasks WHERE id = ?")
        .get(doc.taskId) as { record: string } | null;
      let callName = "codemode_call";
      let callArgs: Record<string, unknown> = {};
      let startedAt: number | null = null;
      let endedAt: number | null = null;
      if (pointedTask) {
        try {
          const trec = JSON.parse(pointedTask.record) as Record<string, unknown>;
          startedAt = typeof trec.startedAt === "number" ? trec.startedAt : null;
          endedAt = typeof trec.endedAt === "number" ? trec.endedAt : null;
          const input = trec.input as { kind?: string; call?: { name?: string; arguments?: Record<string, unknown> } } | undefined;
          if (input?.kind === "nested" && input.call) {
            if (typeof input.call.name === "string") callName = input.call.name;
            if (input.call.arguments && typeof input.call.arguments === "object") callArgs = input.call.arguments;
          }
        } catch {}
      }
      const durationMs =
        startedAt !== null && endedAt !== null && endedAt >= startedAt
          ? endedAt - startedAt
          : typeof doc.result?.durationMs === "number" && Number.isFinite(doc.result.durationMs)
            ? doc.result.durationMs
            : null;
      const isError = Boolean(doc.result?.isError);
      facts.push({
        key: `tool:nested:${doc.taskId}`,
        sessionId: id,
        kind: "tool",
        ts: startedAt,
        name: callName,
        model: null,
        source: "codemode",
        durationMs,
        error: isError,
        aborted: false,
        data: {},
        usage: null,
      });
      if (callName === "skill" && callArgs.action === "view" && typeof callArgs.name === "string") {
        facts.push({
          key: `skill:nested:${doc.taskId}`,
          sessionId: id,
          kind: "skill",
          ts: startedAt,
          name: callArgs.name,
          model: null,
          source: "codemode",
          durationMs,
          error: isError,
          aborted: false,
          data: { file_path: typeof callArgs.file_path === "string" ? callArgs.file_path : null },
          usage: null,
        });
      }
      if (callName === "session_status" && startedAt !== null) {
        facts.push({
          key: `wait:nested:${doc.taskId}`,
          sessionId: id,
          kind: "wait",
          ts: startedAt,
          name: "session_status",
          model: null,
          source: "codemode",
          durationMs: null,
          error: isError,
          aborted: false,
          data: {},
          usage: null,
        });
      }
    }
  }

  // UsageDoc (all-time totals, models only — do not duplicate tool usage)
  const usage = emptyMetrics();
  const modelUsage: Record<string, AnalyticsMetrics> = {};
  const toolUsage: Record<string, AnalyticsMetrics> = {};
  const usageDoc = readCurrentDoc(db, "pi.usage", "conversation", id) as
    | {
        models?: Record<string, Record<string, unknown>>;
        tools?: Record<string, Record<string, unknown>>;
      }
    | undefined;
  if (usageDoc?.models && typeof usageDoc.models === "object") {
    for (const [mKey, mUsage] of Object.entries(usageDoc.models)) {
      addUsage(usage, mUsage);
      const m = emptyMetrics();
      addUsage(m, mUsage);
      modelUsage[mKey] = m;
    }
  }
  if (usageDoc?.tools && typeof usageDoc.tools === "object") {
    for (const [tKey, tUsage] of Object.entries(usageDoc.tools)) {
      const m = emptyMetrics();
      addUsage(m, tUsage);
      toolUsage[tKey] = m;
    }
  }

  // Quota waits (luna.limit-waits, session-scoped)
  const limitWaitsDoc = readCurrentDoc(db, "luna.limit-waits", "session", 0) as
    | { waits?: Record<string, Record<string, unknown>> }
    | undefined;
  const convWait = limitWaitsDoc?.waits?.[String(id)];
  if (convWait && typeof convWait === "object") {
    const firstFailedAt = typeof convWait.firstFailedAt === "number" ? convWait.firstFailedAt : null;
    const resumeAt = typeof convWait.resumeAt === "number" ? convWait.resumeAt : null;
    if (firstFailedAt !== null) {
      facts.push({
        key: `quota_wait:${id}`,
        sessionId: id,
        kind: "quota_wait",
        ts: firstFailedAt,
        name: "quota_wait",
        model: typeof convWait.model === "string" ? convWait.model : null,
        source: null,
        durationMs: null,
        error: false,
        aborted: false,
        data: {
          plannedResetAt: resumeAt,
          exact: Boolean(convWait.exact),
          resetSource: typeof convWait.resetSource === "string" ? convWait.resetSource : null,
        },
        usage: null,
      });
    }
  }

  // Session metadata
  const createdDoc = readCurrentDoc(db, "luna.session-created", "conversation", id) as { at?: number } | undefined;
  const createdAt = typeof createdDoc?.at === "number" ? createdDoc.at : null;

  const execTargetDoc = readCurrentDoc(db, "luna.exec-target", "conversation", id) as { worker?: unknown } | undefined;
  const worker = execTargetDoc?.worker != null ? String(execTargetDoc.worker) : "main";

  let title: string | null = null;
  let archived = false;
  let pinned = false;
  if (tableExists(db, "luna_conversations")) {
    const lc = db
      .query("SELECT title, archived, pinned FROM luna_conversations WHERE id = ?")
      .get(id) as { title: string | null; archived: number; pinned: number } | null;
    if (lc) {
      title = lc.title ?? null;
      archived = Boolean(lc.archived);
      pinned = Boolean(lc.pinned);
    }
  }

  let projectId = 0;
  let projectName = "Default";
  if (tableExists(db, "luna_session_projects") && tableExists(db, "luna_projects")) {
    const sp = db
      .query(
        "SELECT p.id, p.name FROM luna_session_projects sp JOIN luna_projects p ON p.id = sp.project_id WHERE sp.conversation_id = ?",
      )
      .get(id) as { id: number; name: string } | null;
    if (sp) {
      projectId = sp.id;
      projectName = sp.name;
    }
  }

  let parentId: number | null = null;
  try {
    const convRec = JSON.parse(conv.record) as { parent?: { conversationId?: number | string } };
    const pid = convRec.parent?.conversationId;
    if (pid != null && Number.isFinite(Number(pid))) parentId = Number(pid);
  } catch {}

  // Delegation children from luna.delegate.children (children are ownerless)
  const childrenDoc = readCurrentDoc(db, "luna.delegate.children", "conversation", id) as
    | { children?: Array<{ id?: number }> }
    | undefined;
  const childRows = Array.isArray(childrenDoc?.children) ? childrenDoc.children : [];
  for (const child of childRows) {
    if (typeof child?.id !== "number") continue;
    const resultDoc = readCurrentDoc(db, "luna.delegate.result", "conversation", child.id) as
      | { schema?: unknown; result?: unknown }
      | undefined;
    const outcome = resultDoc?.result !== undefined ? "completed" : "pending";
    facts.push({
      key: `delegation:${id}:child:${child.id}`,
      sessionId: id,
      kind: "delegation",
      ts: null,
      name: "delegate.child",
      model: null,
      source: null,
      durationMs: null,
      error: false,
      aborted: false,
      data: {
        sourceSessionId: id,
        targetSessionId: child.id,
        outcome,
      },
      usage: null,
    });
  }

  // Workflow counters
  const goalDoc = readCurrentDoc(db, "luna.goal", "conversation", id) as { goal?: { status?: string } | null } | undefined;
  const goals = goalDoc?.goal ? 1 : 0;
  const completedGoals = goalDoc?.goal?.status === "complete" ? 1 : 0;

  const todoDoc = readCurrentDoc(db, "luna.todo", "conversation", id) as { tasks?: Array<{ status?: string }> } | undefined;
  const todoTasks = (Array.isArray(todoDoc?.tasks) ? todoDoc.tasks : []).filter((t) => t && t.status !== "deleted");
  const todos = todoTasks.length;
  const completedTodos = todoTasks.filter((t) => t.status === "completed").length;

  const visionDoc = readCurrentDoc(db, "luna.vision", "conversation", id) as { counts?: Record<string, number> } | undefined;
  let visionCalls = 0;
  if (visionDoc?.counts && typeof visionDoc.counts === "object") {
    for (const c of Object.values(visionDoc.counts)) {
      if (typeof c === "number" && Number.isFinite(c)) visionCalls += c;
    }
  }

  const seenUploadIds = new Set<string>(
    rebuild ? [] : ((previous as (AnalyticsSessionRecord & { uploadIds?: string[] }) | undefined)?.uploadIds ?? []),
  );
  let uploads = rebuild ? 0 : (previous?.workflow.uploads ?? 0);
  let uploadBytes = rebuild ? 0 : (previous?.workflow.uploadBytes ?? 0);
  const newUploadIds = [...referencedUploadIds].filter((uid) => !seenUploadIds.has(uid));
  if (newUploadIds.length > 0 && tableExists(db, "luna_uploads")) {
    const placeholders = newUploadIds.map(() => "?").join(",");
    const upRows = db
      .query(`SELECT id, size, created_at FROM luna_uploads WHERE id IN (${placeholders})`)
      .all(...newUploadIds) as { id: string; size: number; created_at: number }[];
    uploads += upRows.length;
    for (const u of upRows) {
      seenUploadIds.add(u.id);
      uploadBytes += u.size;
      facts.push({
        key: `upload:${id}:${u.id}`,
        sessionId: id,
        kind: "upload",
        ts: u.created_at,
        name: u.id,
        model: null,
        source: null,
        durationMs: null,
        error: false,
        aborted: false,
        data: { size: u.size },
        usage: null,
      });
    }
  }

  const session: AnalyticsSessionRecord = {
    id,
    title,
    parentId,
    projectId,
    projectName,
    worker,
    cwd: execCwd,
    createdAt,
    lastActivity,
    status: previous?.status ?? "ready",
    statusReason: previous?.statusReason ?? null,
    archived,
    pinned,
    deletedAt: previous?.deletedAt ?? null,
    lastEntryId,
    revision: currentRevision,
    userTurns,
    assistantTurns,
    subagentCount: childRows.length,
    forkDepth: computeForkDepth(db, parentId),
    usage,
    modelUsage,
    toolUsage,
    workflow: {
      goals,
      completedGoals,
      todos,
      completedTodos,
      visionCalls,
      uploads,
      uploadBytes,
    },
  };
  (session as AnalyticsSessionRecord & { uploadIds?: string[] }).uploadIds = [...seenUploadIds];

  return {
    session,
    facts,
    rebuild,
    entriesScanned: entryRows.length,
  };
}
