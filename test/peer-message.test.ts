import { describe, expect, test } from "bun:test";
import { parsePeerMessage } from "../web/src/lib/peer-message.js";
import { crewReportHeader } from "../src/session-crew.js";
import { subagentHeader, subagentTerminalHeader } from "../src/subagent-notify.js";

describe("parsePeerMessage", () => {
  test("parses crew automatic report as crew-report", () => {
    const header = crewReportHeader(42, "build-worker", "finished");
    const entry = { kind: "luna.xsession.msg", data: { from: 42 } };
    const parsed = parsePeerMessage(entry, `${header}\n\nAll tests passed.`);
    expect(parsed).toEqual({
      kind: "crew-report",
      from: 42,
      title: "build-worker",
      state: "finished",
      body: "All tests passed.",
    });
  });

  test("parses subagent blocked report as subagent-report", () => {
    const header = subagentHeader(77, "check logs", "needs_input", "missing API key");
    const entry = { kind: "luna.xsession.msg", data: { from: 77 } };
    const parsed = parsePeerMessage(entry, `${header}\n\nPlease provide the key.`);
    expect(parsed).toEqual({
      kind: "subagent-report",
      from: 77,
      title: "check logs",
      state: "needs_input",
      body: "Please provide the key.",
    });
  });

  test("parses subagent terminal report as subagent-report", () => {
    const header = subagentTerminalHeader(88, "run audit", "ok");
    const entry = { kind: "luna.xsession.msg", data: { from: 88 } };
    const parsed = parsePeerMessage(entry, `${header}\n\nAudit clean.`);
    expect(parsed).toEqual({
      kind: "subagent-report",
      from: 88,
      title: "run audit",
      state: "ok",
      body: "Audit clean.",
    });
  });

  test("parses plain peer message as peer", () => {
    const header = '[message from session #10 "lead-session": a peer session, not the user. Reply with session_send.]';
    const entry = { kind: "luna.xsession.msg", data: { from: 10 } };
    const parsed = parsePeerMessage(entry, `${header}\n\nPlease fix bug #1.`);
    expect(parsed).toEqual({
      kind: "peer",
      from: 10,
      title: "lead-session",
      body: "Please fix bug #1.",
    });
  });

  test("ignores non-xsession entries or mismatched sender id", () => {
    const header = crewReportHeader(42, "build-worker", "finished");
    expect(parsePeerMessage({ kind: "pi.user", data: { from: 42 } }, `${header}\n\nhi`)).toBeUndefined();
    expect(parsePeerMessage({ kind: "luna.xsession.msg", data: { from: 99 } }, `${header}\n\nhi`)).toBeUndefined();
  });
});
