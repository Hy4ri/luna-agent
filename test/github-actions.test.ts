// GitHub writes with a stubbed fetch: no network, no real repository.
import { afterEach, beforeEach, test, expect } from "bun:test";
import { GhError } from "../src/github.js";
import { filterQualifiers } from "../src/github-list.js";
import { createIssue, createPull, editItem, review, setDraft, updatePullBranch } from "../src/github-write.js";
import { rejectsWith, throwsWith } from "./support/expect-error.js";

type Call = { url: string; method: string; body: any };
let calls: Call[] = [], realFetch: typeof fetch, headOid = "a".repeat(40), isDraft = false, merged = false, prState = "OPEN";
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

function detailNode(kind: "pr" | "issue") {
  const base = { id: "NODE", number: 7, title: "t", state: prState, url: "u", createdAt: "2026-01-01T00:00:00Z", body: "", author: { login: "me" }, viewerCanUpdate: true, locked: false,
    labels: { nodes: [{ name: "bug", color: "ff0000" }] }, assignees: { nodes: [{ login: "me" }] }, comments: { totalCount: 0, pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] } };
  return kind === "issue" ? { __typename: "Issue", ...base, viewerCanDelete: false }
    : { __typename: "PullRequest", ...base, isDraft, merged, baseRefName: "main", headRefName: "f", headRefOid: headOid, isCrossRepository: false,
      headRepository: { nameWithOwner: "o/r", viewerPermission: "WRITE", defaultBranchRef: { name: "main" } }, headRef: { name: "f" }, additions: 1, deletions: 0, changedFiles: 1,
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, reviews: { nodes: [] }, commits: { nodes: [] } };
}
beforeEach(() => {
  calls = []; headOid = "a".repeat(40); isDraft = false; merged = false; prState = "OPEN";
  process.env.GH_TOKEN = "test-token"; realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input), body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    if (url.endsWith("/graphql")) {
      const q: string = body.query;
      if (q.includes("issueOrPullRequest")) return json({ data: { repository: { isArchived: false, viewerPermission: "WRITE", issueOrPullRequest: detailNode(q.includes("PullRequest") && body.variables.n === 7 && kindOf === "pr" ? "pr" : kindOf) } } });
      return json({ data: { ok: {} } });
    }
    if (url.includes("/issues") && init?.method === "POST") return json({ number: 12, html_url: "https://github.com/o/r/issues/12" }, 201);
    if (url.includes("/pulls") && init?.method === "POST" && !url.includes("reviews")) return json({ number: 13, html_url: "https://github.com/o/r/pull/13" }, 201);
    return json({});
  }) as typeof fetch;
});
let kindOf: "pr" | "issue" = "pr";
afterEach(() => { globalThis.fetch = realFetch; });
const writes = () => calls.filter(c => c.method !== "GET" && !c.url.endsWith("/graphql"));
const mutations = () => calls.filter(c => c.url.endsWith("/graphql") && /mutation/.test(c.body.query));

test("create issue and pull request send only the given fields", async () => {
  expect(await createIssue("o/r", { title: "T", labels: ["bug"] })).toStrictEqual({ number: 12, url: "https://github.com/o/r/issues/12" });
  expect(writes()[0]!.body).toStrictEqual({ title: "T", labels: ["bug"] });
  expect(await createPull("o/r", { title: "P", head: "f", base: "main", draft: true })).toStrictEqual({ number: 13, url: "https://github.com/o/r/pull/13" });
  expect(writes()[1]!.body).toStrictEqual({ title: "P", head: "f", base: "main", draft: true });
});

test("edit patches the issue endpoint with changed fields only, and rejects an empty edit", async () => {
  kindOf = "issue";
  await editItem("o/r", "issue", 7, { labels: ["bug", "docs"], assignees: [] });
  const w = writes()[0]!;
  expect(w.method).toBe("PATCH"); expect(w.url).toMatch(/repos\/o\/r\/issues\/7$/);
  expect(w.body).toStrictEqual({ labels: ["bug", "docs"], assignees: [] });
  await rejectsWith(editItem("o/r", "issue", 7, {}), (e: any) => e instanceof GhError && e.status === 400);
  await rejectsWith(editItem("o/r", "pr", 7, { title: "x" }), (e: any) => e instanceof GhError && e.status === 400);
});

test("review pins the reviewed commit, refuses a stale head, and needs a comment unless approving", async () => {
  kindOf = "pr";
  await review("o/r", 7, { event: "APPROVE", sha: headOid });
  expect(writes()[0]!.body).toStrictEqual({ event: "APPROVE", commit_id: headOid });
  await rejectsWith(review("o/r", 7, { event: "REQUEST_CHANGES", sha: headOid }), (e: any) => e.status === 400);
  await rejectsWith(review("o/r", 7, { event: "COMMENT", body: "x", sha: "b".repeat(40) }), (e: any) => e.status === 409);
  prState = "CLOSED";
  await rejectsWith(review("o/r", 7, { event: "APPROVE", sha: headOid }), (e: any) => e.status === 422);
  expect(writes().length).toBe(1);
});

test("draft toggle only mutates when the state differs", async () => {
  kindOf = "pr";
  await setDraft("o/r", 7, false);
  expect(mutations().length).toBe(0);
  await setDraft("o/r", 7, true);
  expect(mutations()[0]!.body.query).toMatch(/convertPullRequestToDraft/);
  isDraft = true;
  await setDraft("o/r", 7, false);
  expect(mutations()[1]!.body.query).toMatch(/markPullRequestReadyForReview/);
});

test("update branch sends the expected head and refuses a stale one", async () => {
  kindOf = "pr";
  await updatePullBranch("o/r", 7, headOid);
  expect(writes()[0]!.method).toBe("PUT"); expect(writes()[0]!.body).toStrictEqual({ expected_head_sha: headOid });
  await rejectsWith(updatePullBranch("o/r", 7, "c".repeat(40)), (e: any) => e.status === 409);
});

test("list filters become search qualifiers and cannot inject others", () => {
  expect(filterQualifiers("pr", { author: "@me", label: "good first issue", draft: "false", review: "approved" })).toBe('author:@me label:"good first issue" draft:false review:approved');
  expect(filterQualifiers("issue", { draft: "true", review: "approved" })).toBe("");
  throwsWith(() => filterQualifiers("pr", { author: "x is:open" }), GhError);
  throwsWith(() => filterQualifiers("pr", { label: 'a" repo:other/x' }), GhError);
  throwsWith(() => filterQualifiers("pr", { review: "all" as never }), GhError);
});

test("a merged pull request stays editable though it cannot be closed", async () => {
  kindOf = "pr"; prState = "MERGED"; merged = true;
  const { detail } = await import("../src/github-detail.js");
  const d = await detail("o", "r", 7);
  expect(d.state).toBe("MERGED");
  expect(d.can.close).toBe(false);
  expect(d.can.edit).toBe(true);
});
