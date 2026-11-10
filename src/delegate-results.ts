// Structured child reports are validated data, not proof of correct work or user approval.
import type { JsonValue } from "@earendil-works/chord/json";
import { Type } from "typebox";
import { Compile, Meta } from "typebox/schema";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { ChildResult } from "./delegate-state.js";
import { delegateFilesTool } from "./delegate-files.js";
import { newestInputBoundary } from "./session-status.js";

export const RECEIPT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    commit_sha: { anyOf: [{ type: "string", pattern: "^[0-9a-fA-F]{7,40}$" }, { type: "null" }] },
    pr_url: { anyOf: [{ type: "string" }, { type: "null" }] },
    files_changed: { type: "array", items: { type: "string" } },
    blocked_on: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["commit_sha", "pr_url", "files_changed", "blocked_on"],
};
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_SCHEMA_BYTES = 32 * 1024;
const meta = Compile(Meta["http://json-schema.org/draft-07/schema#"]);

/** Only local references are accepted. No network or host schema resolution is involved. */
export function compileResultSchema(schema: Record<string, unknown>) {
  if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_SCHEMA_BYTES) throw new Error("outputSchema exceeds 32 KiB.");
  if (!meta.Check(schema)) throw new Error("outputSchema must be a valid JSON Schema draft-07 object.");
  const visit = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (depth > 32) throw new Error("outputSchema nesting exceeds 32 levels.");
    const node = value as Record<string, unknown>;
    if (typeof node.$ref === "string" && node.$ref !== "#" && !node.$ref.startsWith("#/"))
      throw new Error("outputSchema references must be local JSON pointers.");
    if (node.$schema !== undefined && node.$schema !== "http://json-schema.org/draft-07/schema#")
      throw new Error("outputSchema supports JSON Schema draft-07 only.");
    for (const key of ["properties", "patternProperties", "definitions", "dependencies"]) {
      const map = node[key];
      if (map && typeof map === "object" && !Array.isArray(map)) for (const nested of Object.values(map)) visit(nested, depth + 1);
    }
    for (const key of ["items", "allOf", "anyOf", "oneOf"]) {
      const nested = node[key];
      if (Array.isArray(nested)) for (const item of nested) visit(item, depth + 1);
      else visit(nested, depth + 1);
    }
    for (const key of ["additionalProperties", "additionalItems", "contains", "propertyNames", "not", "if", "then", "else"]) visit(node[key], depth + 1);
  };
  visit(schema);
  return Compile(schema);
}

export const delegateResultTool = defineTool({
  name: "delegate_result",
  description: "Submit the result required by your parent's outputSchema. Read the schema in your task brief. Valid data is not verified work or approval. Call again after new input or steering.",
  deferred: true,
  parameters: Type.Object({ value: Type.Unknown({ description: "JSON value that satisfies the assigned outputSchema." }) }),
  replay: "safe",
  execute: async (args, api, context) => {
    const text = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], isError });
    const serialized = JSON.stringify(args.value);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) return text("Result must be JSON and at most 64 KiB.", true);
    return api.commit(async tx => {
      const doc = await tx.doc(ChildResult, api.conversationId);
      if (!doc.schema) return text("This conversation has no assigned child result schema.", true);
      try {
        if (!compileResultSchema(doc.schema).Check(args.value)) return text("Result rejected: it does not satisfy the assigned outputSchema. Correct the value and call delegate_result again.", true);
      } catch (error) { return text(`Result validation unavailable: ${(error as Error).message}`, true); }
      doc.result = { boundary: await newestInputBoundary(tx, api.conversationId), value: JSON.parse(serialized) as JsonValue };
      return text("Result accepted against the assigned schema. This does not verify your work or grant approval. Finish with a concise summary.");
    }, context);
  },
});
export const DelegateResults = defineExtension({
  name: "delegate-results", tools: [delegateResultTool, delegateFilesTool],
  sections: [section("delegate-result", async ({ read, conversationId }, context) => {
    const contract = await read.snapshot(ChildResult, conversationId, context);
    return contract?.schema ? `Before ending assigned work, call delegate_result with a value matching this JSON Schema:\n${JSON.stringify(contract.schema)}\nAfter new input or steering, submit a new result. Schema validation is not proof of correct work or approval. If blocked, use session_status instead of claiming completion.` : undefined;
  })],
});
