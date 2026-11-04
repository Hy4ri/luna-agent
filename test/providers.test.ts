import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBaseUrl } from "../src/providers.js";

test("custom provider base URL accepts a pasted endpoint URL", () => {
  const cases: [string, string][] = [
    ["https://api.example.com/v1/chat/completions", "https://api.example.com/v1"],
    ["https://api.example.com/v1/chat/completions/", "https://api.example.com/v1"],
    ["https://api.example.com/v1/responses", "https://api.example.com/v1"],
    ["https://api.example.com/v1/messages", "https://api.example.com/v1"],
    ["https://api.example.com/v1/", "https://api.example.com/v1"],
    ["https://api.example.com/v1", "https://api.example.com/v1"],
  ];
  for (const [input, want] of cases) assert.equal(normalizeBaseUrl(input), want);
});
