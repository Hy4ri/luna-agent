import { Database, type Statement } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";

const DEFAULT_WAL_AUTO_CHECKPOINT_PAGES = 1_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const STATEMENT_CACHE_LIMIT = 256;
const ignore = () => {};

export type BunSqliteDatabaseOptions = {
  /** SQLite WAL auto-checkpoint threshold. SQLite and this adapter default to 1,000 pages; 0 disables it. */
  readonly walAutoCheckpointPages?: number;
  /** Time SQLite waits for a competing file lock. SQLite defaults to 0; this adapter defaults to 5,000 ms. */
  readonly busyTimeoutMs?: number;
};

/**
 * Runs operations in call order. An operation starts immediately when nothing is running or waiting;
 * otherwise it waits for everything before it. An asynchronous operation holds the queue until it settles.
 */
class SerialOperationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(operation: () => T): Promise<T> {
    if (this.pending > 0) return this.enqueue(operation);
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  runAsync<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending > 0) return this.enqueue(operation);
    this.pending++;
    const { promise: barrier, resolve: releaseBarrier } = Promise.withResolvers<void>();
    this.tail = barrier;
    let started: Promise<T>;
    try {
      started = operation();
    } catch (error) {
      started = Promise.reject(error);
    }
    return started.finally(() => {
      this.pending--;
      releaseBarrier();
    });
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    this.pending++;
    return this.release(this.tail.then(operation));
  }

  private release<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.finally(() => {
      this.pending--;
    });
    this.tail = settled.then(ignore, ignore);
    return settled;
  }
}

/**
 * Executes SQL on one connection. Prepared statements are cached per connection by SQL text, so the
 * database and its transaction handles share them across transactions. The cache keeps the
 * `STATEMENT_CACHE_LIMIT` most recently used statements, so callers generating SQL of unbounded shapes
 * cannot grow it without bound.
 */
abstract class BunSqliteExecutor implements SqliteExecutor {
  protected readonly database: Database;
  protected readonly statements: Map<string, Statement>;

  constructor(database: Database, statements: Map<string, Statement>) {
    this.database = database;
    this.statements = statements;
  }

  exec(sql: string): Promise<void> {
    return this.runOperation(() => {
      this.database.exec(sql);
    });
  }

  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.runOperation(() => {
      this.statement(sql).run(...params);
    });
  }

  runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
    return this.runOperation(() => Number(this.statement(sql).run(...params).changes));
  }

  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.runOperation(() => (this.statement(sql).get(...params) as T | null) ?? undefined);
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.runOperation(() => this.statement(sql).all(...params) as T[]);
  }

  protected abstract runOperation<T>(operation: () => T): Promise<T>;

  private statement(sql: string): Statement {
    const statements = this.statements;
    let statement = statements.get(sql);
    if (statement !== undefined) {
      if (statements.size > STATEMENT_CACHE_LIMIT / 2) {
        statements.delete(sql);
        statements.set(sql, statement);
      }
      return statement;
    }
    statement = this.database.prepare(sql);
    statements.set(sql, statement);
    if (statements.size > STATEMENT_CACHE_LIMIT) {
      const oldest = statements.keys().next().value;
      if (oldest !== undefined) statements.delete(oldest);
    }
    return statement;
  }
}

class BunSqliteTransaction extends BunSqliteExecutor {
  private readonly scope: { active: boolean };

  constructor(database: Database, statements: Map<string, Statement>, scope: { active: boolean }) {
    super(database, statements);
    this.scope = scope;
  }

  protected async runOperation<T>(operation: () => T): Promise<T> {
    if (!this.scope.active) throw new Error("SQLite transaction handle is no longer active");
    return operation();
  }
}

/** `SqliteDatabase` adapter backed by Bun's built-in `bun:sqlite`. */
export class BunSqliteDatabase extends BunSqliteExecutor implements SqliteDatabase {
  private readonly access = new SerialOperationQueue();
  private closed = false;

  constructor(database: Database) {
    super(database, new Map());
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.access.runAsync(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      const scope = { active: true };
      try {
        const result = await callback(new BunSqliteTransaction(this.database, this.statements, scope));
        scope.active = false;
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        scope.active = false;
        try {
          this.database.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.access.run(() => {
      if (this.closed) return;
      this.closed = true;
      for (const stmt of this.statements.values()) {
        try {
          stmt.finalize();
        } catch {}
      }
      this.statements.clear();
      try {
        this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        this.database.close();
      }
    });
  }

  protected runOperation<T>(operation: () => T): Promise<T> {
    return this.access.run(operation);
  }
}

/** Open and configure a Bun-backed SQLite database facade. */
export async function openBunSqliteDatabase(path: string, options: BunSqliteDatabaseOptions = {}): Promise<BunSqliteDatabase> {
  const checkpointPages = options.walAutoCheckpointPages ?? DEFAULT_WAL_AUTO_CHECKPOINT_PAGES;
  const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
  const database = new Database(path);
  const adapter = new BunSqliteDatabase(database);
  try {
    await adapter.exec(`PRAGMA busy_timeout = ${timeout}`);
    await adapter.exec("PRAGMA journal_mode = WAL");
    await adapter.exec("PRAGMA synchronous = NORMAL");
    await adapter.exec(`PRAGMA wal_autocheckpoint = ${checkpointPages}`);
    return adapter;
  } catch (error) {
    try {
      await adapter.close();
    } catch {}
    throw error;
  }
}
