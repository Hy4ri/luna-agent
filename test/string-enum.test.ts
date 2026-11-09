import assert from "node:assert/strict";
import { test } from "bun:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { StringEnum } from "../src/string-enum.js";

test("StringEnum: a near-miss value names every valid option, and a valid one passes", () => {
  const tool = { name: "cron", description: "", parameters: Type.Object({ status: Type.Optional(StringEnum(["running", "ok", "error", "skipped"], { description: "runs: keep only this status." })) }) };
  assert.deepEqual(tool.parameters.properties.status, { type: "string", enum: ["running", "ok", "error", "skipped"], description: "runs: keep only this status." });
  assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "1", name: "cron", arguments: { status: "failed" } }),
    (e: Error) => ["running", "ok", "error", "skipped"].every(v => e.message.includes(`"${v}"`)));
  assert.deepEqual(validateToolArguments(tool, { type: "toolCall", id: "2", name: "cron", arguments: { status: "error" } }), { status: "error" });
});
