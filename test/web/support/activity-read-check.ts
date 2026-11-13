// Exercises web/src/stores/sessions.ts dismissActivity & markAllActivitySeen in happy-dom with a mocked fetch.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { plugin } from "bun";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect } from "bun:test";

const webSrc = new URL("../../../web/src/", import.meta.url).pathname;
plugin({
  name: "web-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, ({ path }) => {
      const base = join(webSrc, path.slice(2));
      const hit = [".ts", ".vue", "/index.ts", ""].map(ext => base + ext).find(p => existsSync(p));
      if (!hit) throw new Error(`cannot resolve ${path}`);
      return { path: hit };
    });
  },
});

GlobalRegistrator.register({ url: "http://luna.test/" });

const apiCalls: Array<{ path: string; method: string; body: unknown }> = [];
let nextReadResponse: { ok: boolean; status: string; statusReason: string | null } = { ok: true, status: "ready", statusReason: null };
let failNextPost = false;
let sessionsPayload: Array<Record<string, unknown>> = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  const path = url.pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "POST" && (path.endsWith("/read") || path === "/v1/sessions/read-all")) {
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : {};
    apiCalls.push({ path, method, body });
    if (failNextPost) {
      failNextPost = false;
      return new Response(JSON.stringify({ error: "Network failure" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    if (path.endsWith("/read")) {
      return Response.json(nextReadResponse);
    }
    return Response.json({ ok: true, count: (body.ids ?? []).length, ids: body.ids ?? [] });
  }
  if (method === "GET" && path === "/v1/sessions") {
    return Response.json({ sessions: sessionsPayload, total: sessionsPayload.length, groups: {}, nextCursor: null });
  }
  return Response.json({});
}) as typeof fetch;

const apiMod = await import("../../../web/src/lib/api.ts");
apiMod.setServerUrl("http://luna.test");
apiMod.setToken("test-token");

// Import app store first so circular store init runs in the normal entry order.
await import("../../../web/src/stores/app.ts");
const {
  activity,
  history,
  dismissActivity,
  markAllActivitySeen,
} = await import("../../../web/src/stores/sessions.ts");

function reset() {
  localStorage.clear();
  apiCalls.length = 0;
  failNextPost = false;
  nextReadResponse = { ok: true, status: "ready", statusReason: null };
  activity.items = [];
  history.rows = [];
  history.list = [];
  history.status = "";
}

try {
  // 1. dismissActivity marks finished sessions read on the server and updates local session status
  reset();
  {
    const row = { id: 101, title: "Done session", status: "finished" as const, statusReason: null, lastActivity: 5000 };
    activity.items = [{ ...row }];
    history.rows = [{ ...row }];
    history.list = [{ ...row }];
    sessionsPayload = [{ ...row, status: "ready" }];

    await dismissActivity(101);

    expect(apiCalls).toEqual([{ path: "/v1/sessions/101/read", method: "POST", body: {} }]);
    expect(activity.items).toEqual([]);
    expect(history.rows[0]?.status).toBe("ready");
    expect(history.list[0]?.status).toBe("ready");
  }

  // 2. dismissActivity does not hit /read for non-finished statuses like needs_input
  reset();
  {
    const row = { id: 102, title: "Need input", status: "needs_input" as const, statusReason: "question", lastActivity: 5000 };
    activity.items = [{ ...row }];
    history.rows = [{ ...row }];
    history.list = [{ ...row }];

    await dismissActivity(102);

    expect(apiCalls).toEqual([]);
    expect(activity.items).toEqual([]);
    expect(history.rows[0]?.status).toBe("needs_input");
  }

  // 3. dismissActivity rolls back local status and activity item when the server call fails
  reset();
  {
    const row = { id: 103, title: "Done session", status: "review_finished" as const, statusReason: null, lastActivity: 5000 };
    activity.items = [{ ...row }];
    history.rows = [{ ...row }];
    history.list = [{ ...row }];
    sessionsPayload = [{ ...row }];
    failNextPost = true;

    await dismissActivity(103);

    expect(apiCalls).toEqual([{ path: "/v1/sessions/103/read", method: "POST", body: {} }]);
    expect(history.rows[0]?.status).toBe("review_finished");
    expect(history.list[0]?.status).toBe("review_finished");
    expect(activity.items.map(s => s.id)).toEqual([103]);
    expect(history.status).toBe("Network failure");
  }

  // 4. markAllActivitySeen calls /v1/sessions/read-all for finished/review_finished items and updates their statuses
  reset();
  {
    const s1 = { id: 201, title: "Finished", status: "finished" as const, statusReason: null, lastActivity: 6000 };
    const s2 = { id: 202, title: "Reviewed", status: "review_finished" as const, statusReason: null, lastActivity: 5000 };
    const s3 = { id: 203, title: "Failed", status: "failed" as const, statusReason: "err", lastActivity: 4000 };
    activity.items = [{ ...s1 }, { ...s2 }, { ...s3 }];
    history.rows = [{ ...s1 }, { ...s2 }, { ...s3 }];
    history.list = [{ ...s1 }, { ...s2 }, { ...s3 }];
    sessionsPayload = [{ ...s1, status: "ready" }, { ...s2, status: "ready" }, { ...s3 }];

    await markAllActivitySeen();

    expect(apiCalls).toEqual([{ path: "/v1/sessions/read-all", method: "POST", body: { ids: [201, 202] } }]);
    expect(activity.items).toEqual([]);
    expect(history.rows.map(r => r.status)).toEqual(["ready", "ready", "failed"]);
    expect(history.list.map(r => r.status)).toEqual(["ready", "ready", "failed"]);
  }

  // 5. markAllActivitySeen rolls back statuses and activity items when /read-all fails
  reset();
  {
    const s1 = { id: 301, title: "Finished", status: "finished" as const, statusReason: null, lastActivity: 6000 };
    const s2 = { id: 302, title: "Need input", status: "needs_input" as const, statusReason: "q", lastActivity: 5000 };
    activity.items = [{ ...s1 }, { ...s2 }];
    history.rows = [{ ...s1 }, { ...s2 }];
    history.list = [{ ...s1 }, { ...s2 }];
    sessionsPayload = [{ ...s1 }, { ...s2 }];
    failNextPost = true;

    await markAllActivitySeen();

    expect(apiCalls).toEqual([{ path: "/v1/sessions/read-all", method: "POST", body: { ids: [301] } }]);
    expect(history.rows.map(r => r.status)).toEqual(["finished", "needs_input"]);
    expect(history.list.filter(r => r.id === 301 || r.id === 302).map(r => r.status)).toEqual(["finished", "needs_input"]);
    expect(activity.items.map(s => s.id)).toEqual([301, 302]);
    expect(history.status).toBe("Network failure");
  }
} finally {
  GlobalRegistrator.unregister();
}
