import { afterEach, describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalyticsStore } from "../src/analytics/store.js";
import {
  analyticsDetail,
  analyticsExport,
  analyticsFilterOptions,
  parseAnalyticsFilters,
  queryAnalytics,
} from "../src/analytics/query.js";
import type { AnalyticsFilters, AnalyticsScan } from "../src/analytics/types.js";

const T1 = 1_700_000_000_000;
const T2 = 1_700_003_600_000; // +1h
const T3 = 1_700_007_200_000; // +2h

const tempDirs: string[] = [];
const openStores: AnalyticsStore[] = [];

function createTempStore(): AnalyticsStore {
  const dir = mkdtempSync(join(tmpdir(), "luna-analytics-query-"));
  tempDirs.push(dir);
  const store = new AnalyticsStore(join(dir, "analytics.db"));
  openStores.push(store);
  return store;
}

afterEach(() => {
  while (openStores.length > 0) {
    openStores.pop()!.close();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function seedStore(store: AnalyticsStore): void {
  const scan1: AnalyticsScan = {
    rebuild: true,
    entriesScanned: 5,
    session: {
      id: 1,
      title: "Alpha Session",
      parentId: null,
      projectId: 10,
      projectName: "Alpha",
      worker: "main",
      cwd: "/work/alpha",
      createdAt: T1,
      lastActivity: T2,
      status: "idle",
      statusReason: null,
      archived: false,
      pinned: false,
      deletedAt: null,
      lastEntryId: 5,
      revision: "rev-1",
      userTurns: 2,
      assistantTurns: 2,
      subagentCount: 0,
      forkDepth: 0,
      usage: {
        input: 300,
        output: 150,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 450,
        reasoning: null,
        cacheWrite1h: null,
        cacheHitRate: null,
        cost: { input: 1.5, output: 1.5, cacheRead: 0, cacheWrite: 0, total: 3.0 },
      },
      workflow: {
        goals: 1,
        completedGoals: 1,
        todos: 2,
        completedTodos: 1,
        visionCalls: 0,
        uploads: 0,
        uploadBytes: 0,
      },
    },
    facts: [
      {
        key: "s1:resp:1",
        sessionId: 1,
        kind: "response",
        ts: T1,
        name: "response",
        model: "anthropic/claude-sonnet",
        source: "direct",
        durationMs: 1200,
        error: false,
        aborted: false,
        data: { provider: "anthropic" },
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
          reasoning: null,
          cacheWrite1h: null,
          cacheHitRate: null,
          cost: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 1.0 },
        },
      },
      {
        key: "s1:resp:2",
        sessionId: 1,
        kind: "response",
        ts: T2,
        name: "response",
        model: "openai/gpt-4o",
        source: "direct",
        durationMs: 800,
        error: false,
        aborted: false,
        data: { provider: "openai" },
        usage: {
          input: 200,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 300,
          reasoning: null,
          cacheWrite1h: null,
          cacheHitRate: null,
          cost: { input: 1.0, output: 1.0, cacheRead: 0, cacheWrite: 0, total: 2.0 },
        },
      },
      {
        key: "s1:tool:1",
        sessionId: 1,
        kind: "tool",
        ts: T1 + 100,
        name: "read",
        model: "anthropic/claude-sonnet",
        source: "direct",
        durationMs: 25,
        error: false,
        aborted: false,
        data: {},
        usage: null,
      },
      {
        key: "s1:tool:2",
        sessionId: 1,
        kind: "tool",
        ts: T2 + 100,
        name: "bash",
        model: "openai/gpt-4o",
        source: "codemode",
        durationMs: 150,
        error: true,
        aborted: false,
        data: {},
        usage: null,
      },
      {
        key: "s1:skill:1",
        sessionId: 1,
        kind: "skill",
        ts: T1 + 200,
        name: "git-workflows",
        model: "anthropic/claude-sonnet",
        source: "direct",
        durationMs: 10,
        error: false,
        aborted: false,
        data: {},
        usage: null,
      },
    ],
  };

  const scan2: AnalyticsScan = {
    rebuild: true,
    entriesScanned: 2,
    session: {
      id: 2,
      title: '=SUM(A1), "Beta"',
      parentId: null,
      projectId: 20,
      projectName: "Beta",
      worker: "worker-1",
      cwd: "/work/beta",
      createdAt: T2,
      lastActivity: T3,
      status: "idle",
      statusReason: null,
      archived: false,
      pinned: false,
      deletedAt: T3,
      lastEntryId: 2,
      revision: "rev-2",
      userTurns: 1,
      assistantTurns: 1,
      subagentCount: 0,
      forkDepth: 0,
      usage: {
        input: 500,
        output: 250,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 750,
        reasoning: null,
        cacheWrite1h: null,
        cacheHitRate: null,
        cost: { input: 2.5, output: 2.5, cacheRead: 0, cacheWrite: 0, total: 5.0 },
      },
      workflow: {
        goals: 0,
        completedGoals: 0,
        todos: 0,
        completedTodos: 0,
        visionCalls: 0,
        uploads: 0,
        uploadBytes: 0,
      },
    },
    facts: [
      {
        key: "s2:resp:1",
        sessionId: 2,
        kind: "response",
        ts: T3,
        name: "response",
        model: "openai/gpt-4o",
        source: "direct",
        durationMs: 2000,
        error: false,
        aborted: false,
        data: { provider: "openai" },
        usage: {
          input: 500,
          output: 250,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 750,
          reasoning: null,
          cacheWrite1h: null,
          cacheHitRate: null,
          cost: { input: 2.5, output: 2.5, cacheRead: 0, cacheWrite: 0, total: 5.0 },
        },
      },
      {
        key: "s2:tool:1",
        sessionId: 2,
        kind: "tool",
        ts: T3 + 50,
        name: "=CMD()",
        model: "openai/gpt-4o",
        source: "codemode",
        durationMs: 40,
        error: false,
        aborted: false,
        data: {},
        usage: null,
      },
    ],
  };

  store.apply(scan1);
  store.apply(scan2);
}

describe("parseAnalyticsFilters", () => {
  test("applies defaults and parses valid repeated filters", () => {
    const defaults = parseAnalyticsFilters(new URLSearchParams());
    expect(defaults.includeDeleted).toBe(true);
    expect(defaults.compare).toBe(false);
    expect(defaults.page).toBe(0);
    expect(defaults.limit).toBe(20);
    expect(defaults.search).toBe("");
    expect(defaults.project).toEqual([]);
    expect(defaults.model).toEqual([]);
    expect(defaults.provider).toEqual([]);
    expect(defaults.worker).toEqual([]);
    expect(defaults.cwd).toEqual([]);

    const params = new URLSearchParams([
      ["from", String(T1)],
      ["to", String(T3)],
      ["project", "10"],
      ["project", "20"],
      ["model", "anthropic/claude-sonnet"],
      ["provider", "anthropic"],
      ["worker", "main"],
      ["cwd", "/work/alpha"],
      ["includeDeleted", "false"],
      ["compare", "true"],
      ["page", "2"],
      ["limit", "50"],
      ["search", "alpha"],
      ["source", "codemode"],
    ]);
    const parsed = parseAnalyticsFilters(params);
    expect(parsed.from).toBe(T1);
    expect(parsed.to).toBe(T3);
    expect(parsed.project).toEqual([10, 20]);
    expect(parsed.model).toEqual(["anthropic/claude-sonnet"]);
    expect(parsed.provider).toEqual(["anthropic"]);
    expect(parsed.worker).toEqual(["main"]);
    expect(parsed.cwd).toEqual(["/work/alpha"]);
    expect(parsed.includeDeleted).toBe(false);
    expect(parsed.compare).toBe(true);
    expect(parsed.page).toBe(2);
    expect(parsed.limit).toBe(50);
    expect(parsed.search).toBe("alpha");
    expect(parsed.source).toBe("codemode");
  });

  test("rejects malformed epoch, page, limit, project, and source", () => {
    const badCases = [
      "from=not-a-number",
      "from=12.34",
      "to=abc",
      `from=${T2}&to=${T1}`,
      "page=-1",
      "page=1.5",
      "page=nope",
      "limit=0",
      "limit=101",
      "limit=abc",
      "project=notanint",
      "source=invalid",
    ];
    for (const qs of badCases) {
      expect(() => parseAnalyticsFilters(new URLSearchParams(qs))).toThrow(Error);
    }
  });
});

describe("queryAnalytics", () => {
  test("filters by time [from, to), project, worker, cwd, and includeDeleted", () => {
    const store = createTempStore();
    seedStore(store);

    const all = queryAnalytics(store, "sessions", parseAnalyticsFilters(new URLSearchParams()));
    expect(all.table.total).toBe(2);
    expect(all.table.rows.find(row => row.id === 2)?.deletedAt).toBe(T3);
    const dated = queryAnalytics(store, "sessions", parseAnalyticsFilters(new URLSearchParams(`from=${T1}&to=${T3 + 1}`)));
    expect(dated.table.rows.find(row => row.id === 2)?.deletedAt).toBe(T3);

    const activeOnly = queryAnalytics(
      store,
      "sessions",
      parseAnalyticsFilters(new URLSearchParams("includeDeleted=false")),
    );
    expect(activeOnly.table.total).toBe(1);
    expect(activeOnly.table.rows[0]?.id).toBe(1);

    const byProject = queryAnalytics(
      store,
      "sessions",
      parseAnalyticsFilters(new URLSearchParams("project=20")),
    );
    expect(byProject.table.total).toBe(1);
    expect(byProject.table.rows[0]?.id).toBe(2);

    const byWorker = queryAnalytics(
      store,
      "sessions",
      parseAnalyticsFilters(new URLSearchParams("worker=worker-1")),
    );
    expect(byWorker.table.total).toBe(1);
    expect(byWorker.table.rows[0]?.id).toBe(2);

    const byCwd = queryAnalytics(
      store,
      "sessions",
      parseAnalyticsFilters(new URLSearchParams("cwd=/work/alpha")),
    );
    expect(byCwd.table.total).toBe(1);
    expect(byCwd.table.rows[0]?.id).toBe(1);

    // Time window [T1, T2) includes T1 fact (cost 1.0) and excludes T2 (2.0) and T3 (5.0).
    const timeBounded = queryAnalytics(
      store,
      "models",
      parseAnalyticsFilters(new URLSearchParams(`from=${T1}&to=${T2}`)),
    );
    expect(timeBounded.table.total).toBe(1);
    expect(timeBounded.table.rows[0]?.id).toBe("anthropic/claude-sonnet");
  });

  test("scopes model and provider filters at facts without leaking other models in same session", () => {
    const store = createTempStore();
    seedStore(store);

    const sonnetOnly = queryAnalytics(
      store,
      "models",
      parseAnalyticsFilters(new URLSearchParams("model=anthropic/claude-sonnet")),
    );
    expect(sonnetOnly.table.total).toBe(1);
    expect(sonnetOnly.table.rows[0]?.id).toBe("anthropic/claude-sonnet");
    // Session 1 also has openai/gpt-4o (cost 2.0, tokens 300), which MUST NOT be included.
    expect(sonnetOnly.summary.cost).toBe(1.0);
    expect(sonnetOnly.summary.totalTokens).toBe(150);

    const openaiOnly = queryAnalytics(
      store,
      "models",
      parseAnalyticsFilters(new URLSearchParams("provider=openai")),
    );
    expect(openaiOnly.table.total).toBe(1);
    expect(openaiOnly.table.rows[0]?.id).toBe("openai/gpt-4o");
    // Session 1 gpt-4o (2.0) + Session 2 gpt-4o (5.0) = 7.0; excludes Session 1 sonnet (1.0).
    expect(openaiOnly.summary.cost).toBe(7.0);
  });

  test("supports compare mode with finite bounds and disables compare on all-time with note", () => {
    const store = createTempStore();
    seedStore(store);

    const allTimeCompare = queryAnalytics(
      store,
      "overview",
      parseAnalyticsFilters(new URLSearchParams("compare=true")),
    );
    expect(allTimeCompare.previous).toBe(undefined);
    expect(allTimeCompare.notes.some((n) => /compare/i.test(n))).toBeTruthy();

    const boundedCompare = queryAnalytics(
      store,
      "overview",
      parseAnalyticsFilters(new URLSearchParams(`from=${T2}&to=${T3 + 1}&compare=true`)),
    );
    expect(boundedCompare.previous !== undefined).toBeTruthy();
  });

  test("splits tools by source and includes skill rows in tools tab", () => {
    const store = createTempStore();
    seedStore(store);

    const allTools = queryAnalytics(
      store,
      "tools",
      parseAnalyticsFilters(new URLSearchParams()),
    );
    expect(allTools.table.rows.some((r) => r.kind === "tool")).toBeTruthy();
    expect(allTools.table.rows.some((r) => r.kind === "skill")).toBeTruthy();

    const codemodeOnly = queryAnalytics(
      store,
      "tools",
      parseAnalyticsFilters(new URLSearchParams("source=codemode")),
    );
    expect(codemodeOnly.table.total).toBe(2);
    expect(codemodeOnly.table.rows.every((r) => r.kind === "tool")).toBeTruthy();
  });

  test("supports search, sort, and pagination", () => {
    const store = createTempStore();
    seedStore(store);

    const searched = queryAnalytics(
      store,
      "sessions",
      parseAnalyticsFilters(new URLSearchParams("search=Alpha")),
    );
    expect(searched.table.total).toBe(1);
    expect(searched.table.rows[0]?.id).toBe(1);

    const page0 = queryAnalytics(
      store,
      "sessions",
      parseAnalyticsFilters(new URLSearchParams("page=0&limit=1")),
    );
    const page1 = queryAnalytics(
      store,
      "sessions",
      parseAnalyticsFilters(new URLSearchParams("page=1&limit=1")),
    );
    expect(page0.table.total).toBe(2);
    expect(page0.table.rows.length).toBe(1);
    expect(page1.table.rows.length).toBe(1);
    expect(page0.table.rows[0]?.id).not.toBe(page1.table.rows[0]?.id);
  });
});

describe("analyticsFilterOptions, analyticsDetail, analyticsExport", () => {
  // Contract: a fact's provider is its explicit data.provider, else its model prefix; never both.
  test("provider options use the explicit provider over the model prefix", () => {
    const store = createTempStore();
    seedStore(store);
    store.db.run(`UPDATE analytics_facts SET data = json_set(data, '$.provider', 'openrouter') WHERE model = 'anthropic/claude-sonnet'`);
    store.db.run(`UPDATE analytics_facts SET data = json_remove(data, '$.provider') WHERE model = 'openai/gpt-4o'`);
    expect(analyticsFilterOptions(store).providers.map((p) => p.value)).toEqual(["openai", "openrouter"]);
  });

  test("returns filter options and detail drawer sections", () => {
    const store = createTempStore();
    seedStore(store);

    const options = analyticsFilterOptions(store);
    expect(options.projects.some((p) => p.value === "10")).toBeTruthy();
    expect(options.models.some((m) => m.value === "anthropic/claude-sonnet")).toBeTruthy();
    expect(options.providers.some((p) => p.value === "anthropic" && p.label === "anthropic")).toBeTruthy();
    expect(options.providers.some((p) => p.value === "openai" && p.label === "openai")).toBeTruthy();
    expect(options.providers.length).toBe(2);
    expect(options.workers.some((w) => w.value === "main")).toBeTruthy();
    expect(options.cwds.some((c) => c.value === "/work/alpha")).toBeTruthy();

    const filters: AnalyticsFilters = parseAnalyticsFilters(new URLSearchParams());
    const detail = analyticsDetail(store, "sessions", "session", "1", filters);
    expect(detail !== undefined).toBeTruthy();
    expect(detail!.sections.length > 0).toBeTruthy();
  });

  test("exports full unpaginated CSV with proper escaping and formula guard", () => {
    const store = createTempStore();
    seedStore(store);

    const filters = parseAnalyticsFilters(new URLSearchParams("page=0&limit=1"));
    const csv = analyticsExport(store, "sessions", filters, "csv");
    const lines = csv.trim().split("\n");
    // Header + 2 sessions (unpaginated despite limit=1)
    expect(lines.length).toBe(3);
    // Session 2 title '=SUM(A1), "Beta"' must be formula-guarded and CSV-escaped
    expect(csv.includes(`"'=SUM(A1), ""Beta"""`)).toBeTruthy();

    const json = analyticsExport(store, "sessions", filters, "json");
    const parsed = JSON.parse(json) as unknown[];
    expect(parsed.length).toBe(2);
  });
});


test("every tab and drawer respects fact scope and tools are not counted twice as skills", () => {
  const store = createTempStore(); seedStore(store);
  const all = parseAnalyticsFilters(new URLSearchParams());
  expect(queryAnalytics(store, "overview", all).summary.toolCalls).toBe(3);
  const model = parseAnalyticsFilters(new URLSearchParams("model=anthropic%2Fclaude-sonnet"));
  const sessions = queryAnalytics(store, "sessions", model);
  expect(sessions.table.rows[0]?.cost).toBe(1);
  const projects = queryAnalytics(store, "projects", model);
  expect(projects.table.total).toBe(1);
  expect(projects.table.rows[0]?.cost).toBe(1);
  const speed = queryAnalytics(store, "speed", all);
  expect(speed.table.rows.reduce((n, r) => n + Number(r.count), 0)).toBe(3);
  const excluded = parseAnalyticsFilters(new URLSearchParams("project=20"));
  expect(analyticsDetail(store, "sessions", "session", "1", excluded)).toBe(undefined);
});

describe("memo invalidation, cache isolation, and delegation/xsession scoping", () => {
  test("invalidates memoized query results after store.apply update and store.markDeleted", () => {
    const store = createTempStore();
    seedStore(store);

    const activeFilters = parseAnalyticsFilters(new URLSearchParams("includeDeleted=false"));
    const before = queryAnalytics(store, "sessions", activeFilters);
    expect(before.table.total).toBe(1);

    // Update session 1 via store.apply -> memo must invalidate
    store.apply({
      rebuild: false,
      entriesScanned: 1,
      session: {
        ...store.getSession(1)!,
        title: "Alpha Updated",
        lastEntryId: 6,
        revision: "rev-1b",
      },
      facts: [],
    });
    const afterApply = queryAnalytics(store, "sessions", activeFilters);
    expect(afterApply.table.rows[0]?.title).toBe("Alpha Updated");

    // Mark session 1 deleted -> memo must invalidate and exclude it when includeDeleted=false
    store.markDeleted([1], T3 + 1_000);
    const afterDelete = queryAnalytics(store, "sessions", activeFilters);
    expect(afterDelete.table.total).toBe(0);
  });

  test("isolates memo cache across date scopes and includeDeleted on the same store", () => {
    const store = createTempStore();
    seedStore(store);

    const withDeleted = queryAnalytics(
      store,
      "sessions",
      parseAnalyticsFilters(new URLSearchParams("includeDeleted=true")),
    );
    const withoutDeleted = queryAnalytics(
      store,
      "sessions",
      parseAnalyticsFilters(new URLSearchParams("includeDeleted=false")),
    );
    expect(withDeleted.table.total).toBe(2);
    expect(withoutDeleted.table.total).toBe(1);

    const window1 = queryAnalytics(
      store,
      "models",
      parseAnalyticsFilters(new URLSearchParams(`from=${T1}&to=${T2}`)),
    );
    const window2 = queryAnalytics(
      store,
      "models",
      parseAnalyticsFilters(new URLSearchParams(`from=${T2}&to=${T3 + 1}`)),
    );
    expect(window1.summary.cost).toBe(1.0);
    expect(window2.summary.cost).toBe(7.0);
  });

  test("filters subtree delegated children and xsession edges without cross-scope leakage", () => {
    const store = createTempStore();
    seedStore(store);

    // Add a delegation fact in session 1 (project 10) and an xsession/session_send fact in session 2 (project 20)
    store.apply({
      rebuild: false,
      entriesScanned: 1,
      session: { ...store.getSession(1)!, subagentCount: 1 },
      facts: [
        {
          key: "s1:del:1",
          sessionId: 1,
          kind: "delegation",
          ts: T1 + 300,
          name: "subagent",
          model: "anthropic/claude-sonnet",
          source: "direct",
          durationMs: 500,
          error: false,
          aborted: false,
          data: { childId: 99, role: "researcher" },
          usage: null,
        },
      ],
    });
    store.apply({
      rebuild: false,
      entriesScanned: 1,
      session: store.getSession(2)!,
      facts: [
        {
          key: "s2:xsend:1",
          sessionId: 2,
          kind: "delegation",
          ts: T3 + 100,
          name: "session_send",
          model: "openai/gpt-4o",
          source: "direct",
          durationMs: 200,
          error: false,
          aborted: false,
          data: { targetSessionId: 1 },
          usage: null,
        },
      ],
    });

    const proj10 = queryAnalytics(
      store,
      "delegation",
      parseAnalyticsFilters(new URLSearchParams("project=10")),
    );
    const proj20 = queryAnalytics(
      store,
      "delegation",
      parseAnalyticsFilters(new URLSearchParams("project=20")),
    );
    expect(proj10.table.total).toBe(1);
    expect(proj20.table.total).toBe(1);
    expect(proj10.table.rows[0]?.id).not.toBe(proj20.table.rows[0]?.id);
  });
});

describe("tab-specific temporal series and detail drawers", () => {
  test("tools series tracks real call counts; context series tracks compactions; reliability excludes failed tools; speed tracks measured response durations", () => {
    const store = createTempStore();
    seedStore(store);

    // Add a compaction fact in session 1 and a response with null durationMs
    store.apply({
      rebuild: false,
      entriesScanned: 2,
      session: store.getSession(1)!,
      facts: [
        {
          key: "s1:cmp:1",
          sessionId: 1,
          kind: "compaction",
          ts: T1 + 500,
          name: "compaction",
          model: "anthropic/claude-sonnet",
          source: "direct",
          durationMs: null,
          error: false,
          aborted: false,
          data: {},
          usage: null,
        },
        {
          key: "s1:resp:nodur",
          sessionId: 1,
          kind: "response",
          ts: T2 + 500,
          name: "response",
          model: "openai/gpt-4o",
          source: "direct",
          durationMs: null,
          error: false,
          aborted: false,
          data: { provider: "openai" },
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            reasoning: null,
            cacheWrite1h: null,
            cacheHitRate: null,
            cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
          },
        },
      ],
    });

    const all = parseAnalyticsFilters(new URLSearchParams());

    // tools: real call counts (3 tool facts + 1 skill fact = 4)
    const toolsRes = queryAnalytics(store, "tools", all);
    const toolsCallsSeries = toolsRes.series.find((s) => /calls/i.test(s.name));
    expect(toolsCallsSeries !== undefined).toBeTruthy();
    const toolsSeriesTotal = toolsCallsSeries!.points.reduce((ps, p) => ps + p.y, 0);
    expect(toolsSeriesTotal).toBe(4);

    // context: compaction count (1 compaction fact)
    const contextRes = queryAnalytics(store, "context", all);
    const compactionSeries = contextRes.series.find((s) => /compaction/i.test(s.name));
    expect(compactionSeries !== undefined).toBeTruthy();
    const contextSeriesTotal = compactionSeries!.points.reduce((ps, p) => ps + p.y, 0);
    expect(contextSeriesTotal).toBe(1);

    // reliability: response-only errors (seedStore has 1 failed tool, 0 failed responses -> 0)
    const reliabilityRes = queryAnalytics(store, "reliability", all);
    const errorsSeries = reliabilityRes.series.find((s) => /errors/i.test(s.name));
    expect(errorsSeries !== undefined).toBeTruthy();
    const reliabilityErrors = errorsSeries!.points.reduce((ps, p) => ps + p.y, 0);
    expect(reliabilityErrors).toBe(0);

    // speed: only measured response durations (excludes null durationMs: (1200 + 800 + 2000) / 3)
    const speedRes = queryAnalytics(store, "speed", all);
    const durationSeries = speedRes.series.find((s) => /duration/i.test(s.name));
    expect(durationSeries !== undefined).toBeTruthy();
    expect(durationSeries!.points.every((p) => Number.isFinite(p.y) && p.y > 0)).toBeTruthy();
    expect(Math.abs(Number(speedRes.summary.avgDurationMs) - 4000 / 3) < 0.01).toBeTruthy();
  });

  test("model drawer includes recorded usage with cost components and optional reasoning/cacheWrite1h, and opens for zero-response ledger-only model", () => {
    const store = createTempStore();
    seedStore(store);

    // Add a ledger-only model (0 response facts, only session usage / compaction)
    store.apply({
      rebuild: true,
      entriesScanned: 1,
      session: {
        ...store.getSession(1)!,
        id: 3,
        title: "Ledger Only",
        revision: "rev-3",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 10,
          cacheWrite: 5,
          totalTokens: 135,
          reasoning: 15,
          cacheWrite1h: 5,
          cacheHitRate: 0.1,
          cost: { input: 0.4, output: 0.3, cacheRead: 0.1, cacheWrite: 0.2, total: 1.0 },
        },
        modelUsage: {
          "custom/ledger-only": {
            input: 100,
            output: 20,
            cacheRead: 10,
            cacheWrite: 5,
            totalTokens: 135,
            reasoning: 15,
            cacheWrite1h: 5,
            cacheHitRate: 0.1,
            cost: { input: 0.4, output: 0.3, cacheRead: 0.1, cacheWrite: 0.2, total: 1.0 },
          },
        },
      },
      facts: [
        {
          key: "s3:cmp:1",
          sessionId: 3,
          kind: "compaction",
          ts: T1 + 600,
          name: "compaction",
          model: "custom/ledger-only",
          source: "direct",
          durationMs: null,
          error: false,
          aborted: false,
          data: {},
          usage: {
            input: 100,
            output: 20,
            cacheRead: 10,
            cacheWrite: 5,
            totalTokens: 135,
            reasoning: 15,
            cacheWrite1h: 5,
            cacheHitRate: 0.1,
            cost: { input: 0.4, output: 0.3, cacheRead: 0.1, cacheWrite: 0.2, total: 1.0 },
          },
        },
      ],
    });

    const all = parseAnalyticsFilters(new URLSearchParams());
    const detail = analyticsDetail(store, "models", "model", "custom/ledger-only", all);
    expect(detail !== undefined).toBeTruthy();
    const usageRow = detail!.sections
      .flatMap((s) => s.rows)
      .find((r) => "totalTokens" in r || "cost" in r || "totalCost" in r);
    expect(usageRow !== undefined).toBeTruthy();
    expect("reasoning" in usageRow! || "cacheWrite1h" in usageRow!).toBeTruthy();
  });

  test("session detail metadata includes deletedAt and separates latest ledger", () => {
    const store = createTempStore();
    seedStore(store);

    const all = parseAnalyticsFilters(new URLSearchParams());
    const detail = analyticsDetail(store, "sessions", "session", "2", all);
    expect(detail !== undefined).toBeTruthy();
    const allRows = detail!.sections.flatMap((s) => s.rows);
    const hasDeletedAt = allRows.some((r) => "deletedAt" in r && r.deletedAt === T3);
    expect(hasDeletedAt).toBe(true);
    expect(detail!.sections.length >= 2).toBeTruthy();
  });
});

test("summary splits response and tool failures, and context model rows open a detail", () => {
  const store = createTempStore(); seedStore(store);
  const all = parseAnalyticsFilters(new URLSearchParams());
  const s = queryAnalytics(store, "reliability", all).summary;
  expect(Number(s.responseErrors) + Number(s.toolErrors)).toBe(Number(s.errors));
  expect(s.responseErrorRate).toBe(Number(s.responses) > 0 ? Number(s.responseErrors) / Number(s.responses) : null);
  expect(s.toolErrorRate).toBe(Number(s.toolCalls) > 0 ? Number(s.toolErrors) / Number(s.toolCalls) : null);
  expect(typeof s.aborts).toBe("number");

  const context = queryAnalytics(store, "context", all);
  const rows = context.sections?.flatMap((sec) => sec.table.rows.filter((r) => r.kind === "model")) ?? [];
  expect(rows.length > 0).toBeTruthy();
  for (const row of rows) {
    expect(typeof row.id).toBe("string");
    expect(analyticsDetail(store, "context", "model", String(row.id), all) !== undefined).toBeTruthy();
  }
});

test("tools tab reports toolTokens and toolCost from toolUsage ledger and filtered tool facts", () => {
  const store = createTempStore();
  seedStore(store);
  store.apply({
    rebuild: true,
    entriesScanned: 1,
    session: {
      id: 4,
      title: "Media Tool Usage",
      parentId: null,
      projectId: 10,
      projectName: "Alpha",
      worker: "main",
      cwd: "/work/alpha",
      createdAt: T1,
      lastActivity: T2,
      status: "idle",
      statusReason: null,
      archived: false,
      pinned: false,
      deletedAt: null,
      lastEntryId: 1,
      revision: "rev-4",
      userTurns: 1,
      assistantTurns: 1,
      subagentCount: 0,
      forkDepth: 0,
      usage: {
        input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
        reasoning: null, cacheWrite1h: null, cacheHitRate: null,
        cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
      },
      toolUsage: {
        media_analyze: {
          input: 400, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 500,
          reasoning: null, cacheWrite1h: null, cacheHitRate: null,
          cost: { input: 0.02, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.05 },
        },
      },
      workflow: { goals: 0, completedGoals: 0, todos: 0, completedTodos: 0, visionCalls: 1, uploads: 0, uploadBytes: 0 },
    },
    facts: [
      {
        key: "s4:tool:1",
        sessionId: 4,
        kind: "tool",
        ts: T1 + 50,
        name: "media_analyze",
        model: "anthropic/claude-sonnet",
        source: "direct",
        durationMs: 200,
        error: false,
        aborted: false,
        data: {},
        usage: {
          input: 400, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 500,
          reasoning: null, cacheWrite1h: null, cacheHitRate: null,
          cost: { input: 0.02, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.05 },
        },
      },
    ],
  });

  const all = parseAnalyticsFilters(new URLSearchParams());
  const toolsTab = queryAnalytics(store, "tools", all);
  const mediaRow = toolsTab.table.rows.find((r) => r.name === "media_analyze");
  expect(mediaRow).toBeTruthy();
  expect(mediaRow!.toolTokens).toBe(500);
  expect(mediaRow!.toolCost).toBe(0.05);

  const filtered = parseAnalyticsFilters(new URLSearchParams([["from", String(T1)], ["to", String(T2 + 1)]]));
  const filteredTools = queryAnalytics(store, "tools", filtered);
  const filteredMedia = filteredTools.table.rows.find((r) => r.name === "media_analyze");
  expect(filteredMedia).toBeTruthy();
  expect(filteredMedia!.toolTokens).toBe(500);
  expect(filteredMedia!.toolCost).toBe(0.05);
});
