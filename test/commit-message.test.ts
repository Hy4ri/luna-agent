// Commit message drafts use a fake model: no paid call.
import { test, expect } from "bun:test";
import { GitError } from "../src/git-control.js";
import { PATCH_CHARS, draftCommitMessage, draftInput, parseCommitMessage } from "../src/commit-message.js";
import { rejectsWith } from "./support/expect-error.js";

const staged = { stat: " a.txt | 2 +-", patch: "diff --git a/a.txt b/a.txt\n+x\n", truncated: false };

test("a JSON reply becomes subject and body", async () => {
  const seen: string[] = [];
  const message = await draftCommitMessage(staged, async (_s, input) => { seen.push(input); return '{"subject":"fix: handle empty file.","body":"The reader crashed."}'; });
  expect(message).toBe("fix: handle empty file\n\nThe reader crashed.");
  expect(seen[0]!).toMatch(/a\.txt \| 2/);
});

test("fenced JSON, plain lines, and an overlong subject are cleaned", () => {
  expect(parseCommitMessage('```json\n{"subject":"feat: x","body":""}\n```')).toBe("feat: x");
  expect(parseCommitMessage("feat: plain\n\nwhy")).toBe("feat: plain\n\nwhy");
  expect(parseCommitMessage(JSON.stringify({ subject: "a".repeat(100), body: "" })).length).toBe(72);
  expect(parseCommitMessage('{"subject":')).toBe("");
  expect(parseCommitMessage('{"nope":1}')).toBe("");
});

test("the patch is cut and marked when it is too long", () => {
  const input = draftInput({ stat: "s", patch: "x".repeat(PATCH_CHARS + 50), truncated: false });
  expect(input).toMatch(/Patch \(truncated\)/);
  expect(input.length < PATCH_CHARS + 100).toBeTruthy();
});

test("an empty staged set never reaches the model; a model failure is a 502", async () => {
  let called = false;
  await rejectsWith(draftCommitMessage({ stat: "", patch: "", truncated: false }, async () => { called = true; return ""; }), e => e instanceof GitError && e.status === 400);
  expect(called).toBe(false);
  await rejectsWith(draftCommitMessage(staged, async () => { throw new Error("quota"); }), e => e instanceof GitError && e.status === 502 && /quota/.test(e.message));
  await rejectsWith(draftCommitMessage(staged, async () => "{}"), e => e instanceof GitError && e.status === 502);
});
