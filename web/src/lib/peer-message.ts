export type PeerMessageKind = "crew-report" | "subagent-report" | "peer";

export interface ParsedPeerMessage {
  kind: PeerMessageKind;
  from: number;
  title: string;
  state?: string;
  body: string;
}

// Peer identity comes from metadata on this exact delivered input, never from a typed header.
const PEER_HEADER = /^\[message from session #(\d+) "((?:[^"\\]|\\.)*)": a peer (?:child )?session, not [^\].]+\.([^\]]*)\]\n\n/;
const CREW_REPORT_STATE = /It is a member of your crew; this is its automatic report \(([^)]+)\)\./;
const SUBAGENT_BLOCKED_STATE = /Your subagent stopped and is blocked: ([^.]+)\./;
const SUBAGENT_TERMINAL_STATE = /Child execution finished with outcome: ([^.]+)\./;

export function parsePeerMessage(
  entry: { kind?: string; data?: { from?: unknown } } | null | undefined,
  text: string,
): ParsedPeerMessage | undefined {
  if (!entry || entry.kind !== "luna.xsession.msg") return undefined;
  const m = PEER_HEADER.exec(text);
  if (!m || Number(entry.data?.from) !== Number(m[1])) return undefined;

  const from = Number(m[1]);
  const title = m[2]!;
  const detail = m[3] ?? "";
  const body = text.slice(m[0].length);

  const crewMatch = CREW_REPORT_STATE.exec(detail);
  if (crewMatch) {
    return { kind: "crew-report", from, title, state: crewMatch[1]!.trim(), body };
  }

  const subagentBlockedMatch = SUBAGENT_BLOCKED_STATE.exec(detail);
  if (subagentBlockedMatch) {
    return { kind: "subagent-report", from, title, state: subagentBlockedMatch[1]!.trim(), body };
  }

  const subagentTerminalMatch = SUBAGENT_TERMINAL_STATE.exec(detail);
  if (subagentTerminalMatch) {
    return { kind: "subagent-report", from, title, state: subagentTerminalMatch[1]!.trim(), body };
  }

  return { kind: "peer", from, title, body };
}
