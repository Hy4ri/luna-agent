// Commit message drafts use a fake model: no paid call.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { GitError } from "../src/git-control.js";
import { PATCH_CHARS, draftCommitMessage, draftInput, parseCommitMessage } from "../src/commit-message.js";

const staged = { stat: " a.txt | 2 +-", patch: "diff --git a/a.txt b/a.txt\n+x\n", truncated: false };

test("a JSON reply becomes subject and body", async () => {
  const seen: string[] = [];
  const message = await draftCommitMessage(staged, async (_s, input) => { seen.push(input); return '{"subject":"fix: handle empty file.","body":"The reader crashed."}'; });
  assert.equal(message, "fix: handle empty file\n\nThe reader crashed.");
  assert.match(seen[0]!, /a\.txt \| 2/);
});

test("fenced JSON, plain lines, and an overlong subject are cleaned", () => {
  assert.equal(parseCommitMessage('```json\n{"subject":"feat: x","body":""}\n```'), "feat: x");
  assert.equal(parseCommitMessage("feat: plain\n\nwhy"), "feat: plain\n\nwhy");
  assert.equal(parseCommitMessage(JSON.stringify({ subject: "a".repeat(100), body: "" })).length, 72);
  assert.equal(parseCommitMessage('{"subject":'), "");
  assert.equal(parseCommitMessage('{"nope":1}'), "");
});

test("the patch is cut and marked when it is too long", () => {
  const input = draftInput({ stat: "s", patch: "x".repeat(PATCH_CHARS + 50), truncated: false });
  assert.match(input, /Patch \(truncated\)/);
  assert.ok(input.length < PATCH_CHARS + 100);
});

test("an empty staged set never reaches the model; a model failure is a 502", async () => {
  let called = false;
  await assert.rejects(draftCommitMessage({ stat: "", patch: "", truncated: false }, async () => { called = true; return ""; }), e => e instanceof GitError && e.status === 400);
  assert.equal(called, false);
  await assert.rejects(draftCommitMessage(staged, async () => { throw new Error("quota"); }), e => e instanceof GitError && e.status === 502 && /quota/.test(e.message));
  await assert.rejects(draftCommitMessage(staged, async () => "{}"), e => e instanceof GitError && e.status === 502);
});
