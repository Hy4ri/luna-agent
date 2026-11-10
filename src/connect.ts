// Shared terminal client. The optional local worker runs in this process, independently of the viewed session.
// LUNA_URL + LUNA_TOKEN authenticate the client. LUNA_WORKER_TOKEN optionally starts the local execution worker.
import { createInterface } from "node:readline/promises";
import { startWorker } from "./worker.js";

const base = (process.env.LUNA_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const headers = { "content-type": "application/json", ...(process.env.LUNA_TOKEN ? { authorization: `Bearer ${process.env.LUNA_TOKEN}` } : {}) };
const worker = process.env.LUNA_WORKER_TOKEN ? startWorker({ url: base, token: process.env.LUNA_WORKER_TOKEN, cwd: process.env.LUNA_WORKER_CWD }) : undefined;
delete process.env.LUNA_TOKEN; delete process.env.LUNA_WORKER_TOKEN; // worker commands inherit this environment
const rl = createInterface({ input: process.stdin, output: process.stdout });
let sid = "", watcher: AbortController | undefined;
const seen = new Set<number>();
async function request(path: string, method = "GET", body?: unknown) {
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json() as any;
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}
function text(content: any) { return typeof content === "string" ? content : (content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(""); }
async function showMachine(id: string) {
  const s = await request(`/v1/sessions/${id}/machine`);
  console.log(`[session ${id} · ${s.machine ? `${s.machine.name ?? s.machine.id} · ${s.machine.online ? "online" : "offline"}` : "main"} · ${s.cwd ?? "machine default directory"}]`);
}
function showEntry(entry: any) {
  if (seen.has(entry.id)) return;
  seen.add(entry.id);
  for (const message of entry.model ?? []) {
    const body = text(message.content);
    if (body) console.log(`[${message.role}] ${body}`);
  }
}
async function watch(id: string, controller: AbortController) {
  let streamed = false;
  while (!controller.signal.aborted) {
    try {
      const r = await fetch(`${base}/v1/sessions/${id}/events`, { headers, signal: controller.signal });
      if (!r.ok || !r.body) throw new Error(`events: HTTP ${r.status}`);
      let buf = ""; const dec = new TextDecoder();
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let end;
        while ((end = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, end); buf = buf.slice(end + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const raw = frame.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).join("\n");
          if (!raw) continue;
          const e = JSON.parse(raw);
          if (event === "snapshot") for (const entry of e.entries ?? []) showEntry(entry);
          if (event === "message_start") streamed = false;
          if (event === "message_update") for (const c of e.changes ?? []) if (c.type === "text_delta") { process.stdout.write(c.delta); streamed = true; }
          if (event === "message_end") { if (!streamed) showEntry(e.entry); else { seen.add(e.entry.id); console.log(""); } }
          if (event === "entry_appended") showEntry(e.entry);
          if (event === "tool_execution_start") console.log(`\n[tool ${e.toolName}]`);
          if (event === "tool_execution_update" && e.output) process.stdout.write(e.output.append ?? e.output.set ?? "");
          if (event === "run_end") console.log("\n[turn stopped]");
        }
      }
    } catch (e) { if (controller.signal.aborted) return; console.error(String(e)); }
    await new Promise(r => setTimeout(r, 1000));
  }
}
async function open(id: string) {
  if (!/^\d+$/.test(id)) throw new Error("Use a numeric session id.");
  const s = await request(`/v1/sessions/${id}?limit=30`);
  watcher?.abort(); sid = id; seen.clear();
  await showMachine(id);
  for (const entry of [...s.entries].reverse()) showEntry(entry);
  if (s.questions?.length) console.log("[questions] " + JSON.stringify(s.questions));
  watcher = new AbortController(); void watch(id, watcher);
}
async function sessions() {
  const { sessions } = await request("/v1/sessions");
  for (const s of sessions) {
    const { machine, cwd } = await request(`/v1/sessions/${s.id}/machine`);
    console.log(`${s.id} · ${s.status} · ${s.title} · ${machine ? `${machine.name ?? machine.id} (${machine.online ? "online" : "offline"})` : "main"} · ${cwd ?? "machine default directory"}`);
  }
}
console.log("Shared Luna terminal. Viewing never moves execution. /sessions, /open ID, /new [WORKER_ID], /machine main|ID [DIRECTORY], /status, /stop, /questions, /answer CALL_ID JSON, /quit");
try {
  const i = process.argv.indexOf("--session");
  if (i >= 0) await open(process.argv[i + 1] ?? ""); else await sessions();
  for (;;) {
    const line = (await rl.question("> ").catch(() => "/quit")).trim();
    if (!line) continue;
    if (line === "/quit") break;
    try {
      if (line === "/sessions") { await sessions(); continue; }
      if (line.startsWith("/open ")) { await open(line.slice(6).trim()); continue; }
      if (/^\/new(?:\s|$)/.test(line)) {
        const id = line.slice(4).trim();
        if (id && !/^\d+$/.test(id)) throw new Error("Use /new or /new WORKER_ID.");
        const r = await request("/v1/sessions", "POST", id ? { worker: Number(id) } : {});
        await open(String(r.id)); continue;
      }
      if (!sid) throw new Error("Open or create a session first.");
      if (line === "/status") { await showMachine(sid); continue; }
      if (line === "/stop") { await request(`/v1/sessions/${sid}/abort`, "POST", {}); continue; }
      if (line === "/questions") { console.log(JSON.stringify((await request(`/v1/sessions/${sid}?limit=1`)).questions, null, 2)); continue; }
      if (line.startsWith("/answer ")) {
        const match = /^\/answer\s+(\S+)\s+([\s\S]+)$/.exec(line);
        if (!match) throw new Error("Use /answer CALL_ID JSON.");
        await request(`/v1/sessions/${sid}/questions/${encodeURIComponent(match[1]!)}`, "POST", JSON.parse(match[2]!)); continue;
      }
      if (line.startsWith("/machine ")) {
        const [, machine, cwd] = /^\/machine\s+(\S+)(?:\s+([\s\S]+))?$/.exec(line) ?? [];
        if (!machine || machine !== "main" && !/^\d+$/.test(machine)) throw new Error("Use /machine main|WORKER_ID [DIRECTORY].");
        await request(`/v1/sessions/${sid}/machine`, "PUT", { worker: machine === "main" ? null : Number(machine), ...(cwd ? { cwd } : {}) });
        await showMachine(sid); continue;
      }
      // Async admission keeps the prompt available for stop, answers, and instructions while a turn runs.
      const r = await request(`/v1/sessions/${sid}/messages?async=1`, "POST", { content: line });
      if (r.notice) console.log(r.notice);
    } catch (e) { console.error(String(e)); }
  }
} finally { watcher?.abort(); rl.close(); await worker?.close(); }
