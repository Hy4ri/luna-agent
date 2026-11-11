import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import type { AnalyticsScan, AnalyticsSessionRecord } from "./types.js";

export const ANALYTICS_PARSER_VERSION = 1;

export class AnalyticsStore {
  readonly db: Database;
  readonly parserVersion: number;

  constructor(path: string, parserVersion: number = ANALYTICS_PARSER_VERSION) {
    this.parserVersion = parserVersion;
    this.db = new Database(path);

    // Secure database permissions 0600 if path is on filesystem (fail-closed)
    if (path !== ":memory:") {
      chmodSync(path, 0o600);
    }

    // Configure SQLite pragmas
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA synchronous = NORMAL;");

    this.initSchema();
    this.checkVersionBump();
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS analytics_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS analytics_sessions (
        id INTEGER PRIMARY KEY,
        project_id INTEGER,
        worker TEXT,
        cwd TEXT,
        deleted_at INTEGER,
        created_at INTEGER,
        last_activity INTEGER,
        record TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS analytics_facts (
        key TEXT PRIMARY KEY,
        session_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        ts INTEGER,
        name TEXT,
        model TEXT,
        source TEXT,
        duration_ms REAL,
        error INTEGER NOT NULL,
        aborted INTEGER NOT NULL,
        data TEXT NOT NULL,
        usage TEXT,
        input_tokens REAL,
        output_tokens REAL,
        cache_read REAL,
        cache_write REAL,
        total_tokens REAL,
        cost_total REAL,
        cache_write_1h REAL,
        reasoning_tokens REAL,
        cost_input REAL,
        cost_output REAL,
        cost_cache_read REAL,
        cost_cache_write REAL,
        served_model TEXT,
        thinking_level TEXT,
        provider_thinking_level TEXT,
        error_reason TEXT,
        chars REAL,
        thinking_chars REAL
      );
    `);

    // Detect and migrate missing columns if table existed without them
    const existingCols = new Set(
      this.db
        .query<{ name: string }, []>("PRAGMA table_info(analytics_facts)")
        .all()
        .map((c) => c.name),
    );

    const requiredCols: { name: string; type: "REAL" | "TEXT" }[] = [
      { name: "input_tokens", type: "REAL" },
      { name: "output_tokens", type: "REAL" },
      { name: "cache_read", type: "REAL" },
      { name: "cache_write", type: "REAL" },
      { name: "total_tokens", type: "REAL" },
      { name: "cost_total", type: "REAL" },
      { name: "cache_write_1h", type: "REAL" },
      { name: "reasoning_tokens", type: "REAL" },
      { name: "cost_input", type: "REAL" },
      { name: "cost_output", type: "REAL" },
      { name: "cost_cache_read", type: "REAL" },
      { name: "cost_cache_write", type: "REAL" },
      { name: "served_model", type: "TEXT" },
      { name: "thinking_level", type: "TEXT" },
      { name: "provider_thinking_level", type: "TEXT" },
      { name: "error_reason", type: "TEXT" },
      { name: "chars", type: "REAL" },
      { name: "thinking_chars", type: "REAL" },
    ];

    let addedUsageCols = false;
    let addedDataCols = false;

    for (const { name, type } of requiredCols) {
      if (!existingCols.has(name)) {
        this.db.run(`ALTER TABLE analytics_facts ADD COLUMN ${name} ${type};`);
        if (
          [
            "input_tokens",
            "output_tokens",
            "cache_read",
            "cache_write",
            "total_tokens",
            "cost_total",
            "cache_write_1h",
            "reasoning_tokens",
            "cost_input",
            "cost_output",
            "cost_cache_read",
            "cost_cache_write",
          ].includes(name)
        ) {
          addedUsageCols = true;
        } else {
          addedDataCols = true;
        }
      }
    }

    // Backfill existing facts using json_extract once if any usage column was newly added
    if (addedUsageCols) {
      this.db.run(`
        UPDATE analytics_facts
        SET
          input_tokens = json_extract(usage, '$.input'),
          output_tokens = json_extract(usage, '$.output'),
          cache_read = json_extract(usage, '$.cacheRead'),
          cache_write = json_extract(usage, '$.cacheWrite'),
          total_tokens = json_extract(usage, '$.totalTokens'),
          cost_total = json_extract(usage, '$.cost.total'),
          cache_write_1h = json_extract(usage, '$.cacheWrite1h'),
          reasoning_tokens = json_extract(usage, '$.reasoning'),
          cost_input = json_extract(usage, '$.cost.input'),
          cost_output = json_extract(usage, '$.cost.output'),
          cost_cache_read = json_extract(usage, '$.cost.cacheRead'),
          cost_cache_write = json_extract(usage, '$.cost.cacheWrite')
        WHERE usage IS NOT NULL;
      `);
    }

    // Backfill existing facts using json_extract once if any metadata column was newly added
    if (addedDataCols) {
      this.db.run(`
        UPDATE analytics_facts
        SET
          served_model = json_extract(data, '$.servedModel'),
          thinking_level = json_extract(data, '$.thinkingLevel'),
          provider_thinking_level = json_extract(data, '$.providerThinkingLevel'),
          error_reason = json_extract(data, '$.errorMessage'),
          chars = json_extract(data, '$.chars'),
          thinking_chars = json_extract(data, '$.thinkingChars')
        WHERE data IS NOT NULL;
      `);
    }

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_analytics_facts_session_id
      ON analytics_facts(session_id);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_analytics_facts_kind_ts
      ON analytics_facts(kind, ts);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_analytics_facts_model_ts
      ON analytics_facts(model, ts);
    `);

    // Covering indexes for high-speed query performance
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_facts_rollup
      ON analytics_facts(session_id, kind, error, aborted, duration_ms, ts);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_response_series
      ON analytics_facts(kind, session_id, ts, cost_total, total_tokens);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_response_metrics
      ON analytics_facts(
        kind, model, session_id, input_tokens, output_tokens,
        cache_read, cache_write, total_tokens, cost_total,
        cache_write_1h, reasoning_tokens, cost_input, cost_output,
        cost_cache_read, cost_cache_write, duration_ms, error, ts
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_response_grouping
      ON analytics_facts(kind, model, thinking_level, served_model, error_reason, error, aborted, thinking_chars);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_context
      ON analytics_facts(kind, session_id, ts, chars, thinking_chars, cache_read, duration_ms, name, model);
    `);
  }

  private checkVersionBump(): void {
    const metaRow = this.db
      .query<{ value: string }, [string]>("SELECT value FROM analytics_meta WHERE key = ?")
      .get("parser_version");

    const prevVersion = metaRow ? Number.parseInt(metaRow.value, 10) : null;

    if (prevVersion === null) {
      this.db
        .query("INSERT OR REPLACE INTO analytics_meta (key, value) VALUES (?, ?)")
        .run("parser_version", String(this.parserVersion));
      return;
    }

    if (prevVersion !== this.parserVersion) {
      // Store version bump preserves saved data while rebuild is pending;
      // only blanks revision at bump so retained sessions re-scan/rebuild on demand,
      // and facts are cleared per session when scan.rebuild is true.
      this.db.transaction(() => {
        const retainedRows = this.db
          .query<{ id: number; record: string }, []>(
            "SELECT id, record FROM analytics_sessions WHERE deleted_at IS NULL",
          )
          .all();

        const updateRecord = this.db.query("UPDATE analytics_sessions SET record = ? WHERE id = ?");
        for (const row of retainedRows) {
          const parsed = JSON.parse(row.record);
          parsed.revision = "";
          updateRecord.run(JSON.stringify(parsed), row.id);
        }

        this.db
          .query("INSERT OR REPLACE INTO analytics_meta (key, value) VALUES (?, ?)")
          .run("parser_version", String(this.parserVersion));
      })();
    }
  }

  getSession(id: number): AnalyticsSessionRecord | undefined {
    const row = this.db
      .query<
        {
          id: number;
          project_id: number;
          worker: string;
          cwd: string | null;
          deleted_at: number | null;
          created_at: number | null;
          last_activity: number | null;
          record: string;
        },
        [number]
      >("SELECT * FROM analytics_sessions WHERE id = ?")
      .get(id);

    if (!row) {
      return undefined;
    }

    const record = JSON.parse(row.record) as AnalyticsSessionRecord;

    // Check if parser version changed compared to stored meta version or constructor parserVersion
    // Expose getSession revision empty on version mismatch for retained only.
    const metaRow = this.db
      .query<{ value: string }, [string]>("SELECT value FROM analytics_meta WHERE key = ?")
      .get("parser_version");
    const currentMetaVersion = metaRow ? Number.parseInt(metaRow.value, 10) : this.parserVersion;

    if (row.deleted_at === null) {
      if (currentMetaVersion !== this.parserVersion) {
        record.revision = "";
      }
    }

    return record;
  }

  sessions(): AnalyticsSessionRecord[] {
    const rows = this.db
      .query<{ record: string; deleted_at: number | null }, []>(
        "SELECT record, deleted_at FROM analytics_sessions",
      )
      .all();

    const metaRow = this.db
      .query<{ value: string }, [string]>("SELECT value FROM analytics_meta WHERE key = ?")
      .get("parser_version");
    const currentMetaVersion = metaRow ? Number.parseInt(metaRow.value, 10) : this.parserVersion;

    return rows.map((r) => {
      const record = JSON.parse(r.record) as AnalyticsSessionRecord;
      if (r.deleted_at === null && currentMetaVersion !== this.parserVersion) {
        record.revision = "";
      }
      return record;
    });
  }

  apply(scan: AnalyticsScan): void {
    const { session, facts, rebuild } = scan;

    const applyTx = this.db.transaction(() => {
      // Check existing session row to handle tombstone preservation
      const existing = this.db
        .query<{ deleted_at: number | null; created_at: number | null }, [number]>(
          "SELECT deleted_at, created_at FROM analytics_sessions WHERE id = ?",
        )
        .get(session.id);

      let effectiveDeletedAt = session.deletedAt;

      if (existing && existing.deleted_at !== null) {
        // A tombstone exists.
        // Preserve tombstone unless source proves new incarnation (createdAt > deletedAt)
        const isNewIncarnation =
          session.createdAt !== null &&
          session.createdAt !== undefined &&
          session.createdAt > existing.deleted_at;

        if (!isNewIncarnation) {
          // Stale apply or same incarnation: preserve tombstone
          effectiveDeletedAt = existing.deleted_at;
          session.deletedAt = existing.deleted_at;
        }
      }

      // Upsert / replace session row
      const sessionJson = JSON.stringify(session);
      this.db
        .query(`
          INSERT INTO analytics_sessions (id, project_id, worker, cwd, deleted_at, created_at, last_activity, record)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            worker = excluded.worker,
            cwd = excluded.cwd,
            deleted_at = excluded.deleted_at,
            created_at = excluded.created_at,
            last_activity = excluded.last_activity,
            record = excluded.record
        `)
        .run(
          session.id,
          session.projectId,
          session.worker,
          session.cwd,
          effectiveDeletedAt,
          session.createdAt,
          session.lastActivity,
          sessionJson,
        );

      // If rebuild, delete existing facts for this session
      if (rebuild) {
        this.db.query("DELETE FROM analytics_facts WHERE session_id = ?").run(session.id);
      }

      // Upsert facts keyed by stable key with denormalized numeric and metadata columns
      const insertFact = this.db.query(`
        INSERT INTO analytics_facts (
          key, session_id, kind, ts, name, model, source,
          duration_ms, error, aborted, data, usage,
          input_tokens, output_tokens, cache_read, cache_write,
          total_tokens, cost_total, cache_write_1h, reasoning_tokens,
          cost_input, cost_output, cost_cache_read, cost_cache_write,
          served_model, thinking_level, provider_thinking_level,
          error_reason, chars, thinking_chars
        )
        VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?
        )
        ON CONFLICT(key) DO UPDATE SET
          session_id = excluded.session_id,
          kind = excluded.kind,
          ts = excluded.ts,
          name = excluded.name,
          model = excluded.model,
          source = excluded.source,
          duration_ms = excluded.duration_ms,
          error = excluded.error,
          aborted = excluded.aborted,
          data = excluded.data,
          usage = excluded.usage,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cache_read = excluded.cache_read,
          cache_write = excluded.cache_write,
          total_tokens = excluded.total_tokens,
          cost_total = excluded.cost_total,
          cache_write_1h = excluded.cache_write_1h,
          reasoning_tokens = excluded.reasoning_tokens,
          cost_input = excluded.cost_input,
          cost_output = excluded.cost_output,
          cost_cache_read = excluded.cost_cache_read,
          cost_cache_write = excluded.cost_cache_write,
          served_model = excluded.served_model,
          thinking_level = excluded.thinking_level,
          provider_thinking_level = excluded.provider_thinking_level,
          error_reason = excluded.error_reason,
          chars = excluded.chars,
          thinking_chars = excluded.thinking_chars
      `);

      for (const fact of facts) {
        const u = fact.usage;
        const inputTokens = u?.input ?? null;
        const outputTokens = u?.output ?? null;
        const cacheRead = u?.cacheRead ?? null;
        const cacheWrite = u?.cacheWrite ?? null;
        const totalTokens = u?.totalTokens ?? null;
        const costTotal = u?.cost?.total ?? null;
        const cacheWrite1h = u?.cacheWrite1h ?? null;
        const reasoningTokens = u?.reasoning ?? null;
        const costInput = u?.cost?.input ?? null;
        const costOutput = u?.cost?.output ?? null;
        const costCacheRead = u?.cost?.cacheRead ?? null;
        const costCacheWrite = u?.cost?.cacheWrite ?? null;

        const d = fact.data ?? {};
        const servedModel = typeof d.servedModel === "string" ? d.servedModel : null;
        const thinkingLevel = typeof d.thinkingLevel === "string" ? d.thinkingLevel : null;
        const providerThinkingLevel =
          typeof d.providerThinkingLevel === "string" ? d.providerThinkingLevel : null;
        const errorReason = typeof d.errorMessage === "string" ? d.errorMessage : null;
        const chars = typeof d.chars === "number" ? d.chars : null;
        const thinkingChars = typeof d.thinkingChars === "number" ? d.thinkingChars : null;

        insertFact.run(
          fact.key,
          fact.sessionId,
          fact.kind,
          fact.ts,
          fact.name,
          fact.model,
          fact.source,
          fact.durationMs,
          fact.error ? 1 : 0,
          fact.aborted ? 1 : 0,
          JSON.stringify(d),
          u ? JSON.stringify(u) : null,
          inputTokens,
          outputTokens,
          cacheRead,
          cacheWrite,
          totalTokens,
          costTotal,
          cacheWrite1h,
          reasoningTokens,
          costInput,
          costOutput,
          costCacheRead,
          costCacheWrite,
          servedModel,
          thinkingLevel,
          providerThinkingLevel,
          errorReason,
          chars,
          thinkingChars,
        );
      }
    });

    applyTx();
  }

  markDeleted(ids: number[], at: number): void {
    if (ids.length === 0) return;

    const tx = this.db.transaction(() => {
      const getSession = this.db.query<{ record: string }, [number]>(
        "SELECT record FROM analytics_sessions WHERE id = ?",
      );
      const updateSession = this.db.query(
        "UPDATE analytics_sessions SET deleted_at = ?, record = ? WHERE id = ?",
      );

      for (const id of ids) {
        const row = getSession.get(id);
        if (row) {
          const record = JSON.parse(row.record) as AnalyticsSessionRecord;
          record.deletedAt = at;
          updateSession.run(at, JSON.stringify(record), id);
        }
      }
    });

    tx();
  }

  close(): void {
    this.db.close();
  }
}
