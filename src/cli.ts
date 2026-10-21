// Terminal chat client for a running daemon. Streams answers over SSE.
// Usage: luna-chat [--session <id>] [message...]   (no message: interactive; /new starts a session, /quit exits)
// Env: LUNA_URL (default http://127.0.0.1:8787), LUNA_TOKEN.
import { createInterface } from "node:readline/promises";

// Shared-session mode extends this client without changing the legacy single-message command.
if (process.argv[2] === "connect") {
  await import("./connect.js");
  process.exit(process.exitCode ?? 0);
}

const base = (process.env.LUNA_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const auth: Record<string, string> = process.env.LUNA_TOKEN ? { authorization: `Bearer ${process.env.LUNA_TOKEN}` } : {};

const args = process.argv.slice(2);
let session: string | undefined;
const si = args.indexOf("--session");
if (si >= 0) { session = args[si + 1]; args.splice(si, 2); }

async function newSession(): Promise<string> {
  const r = await fetch(`${base}/v1/sessions`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error(`create session: ${r.status} ${await r.text()}`);
  return String(((await r.json()) as { id: unknown }).id);
}

const sideWatchers = new Map<string, Promise<void>>();
const observer = new AbortController();
function watchSideJob(sessionId: string, jobId: string) {
  if (sideWatchers.has(jobId)) return;
  const worker = (async () => {
    while (!observer.signal.aborted) {
      const response = await fetch(`${base}/v1/sessions/${sessionId}/side-jobs`, { headers: auth, signal: observer.signal });
      if (!response.ok) throw new Error(`side job ${jobId}: ${response.status}`);
      const { jobs } = await response.json() as { jobs: { id: string; kind: string; status: string; prompt: string; text: string; media?: { url: string; name: string }[] }[] };
      const job = jobs.find(j => j.id === jobId);
      if (!job) throw new Error(`side job ${jobId} is unavailable; the daemon may have restarted`);
      if (job.status !== "running") {
        console.log(`\n[/${job.kind} ${job.status}: ${job.prompt.slice(0, 60)} · ${jobId}]\n${job.text}`);
        for (const media of job.media ?? []) console.log(`${media.name}: ${base}${media.url} (requires the API token)`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  })().catch(error => { if (!observer.signal.aborted) console.error(String(error)); }).finally(() => sideWatchers.delete(jobId));
  sideWatchers.set(jobId, worker);
}

/** Send one message and print streamed text and tool activity. */
async function send(id: string, content: string) {
  const r = await fetch(`${base}/v1/sessions/${id}/messages?stream=1`, {
    method: "POST", headers: { ...auth, "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ content }),
  });
  if (!r.ok || !r.body) throw new Error(`send: ${r.status} ${await r.text()}`);
  if ((r.headers.get("content-type") ?? "").includes("application/json")) {
    const result = await r.json() as { notice?: string; tip?: string; job?: { id: string }; queue?: { number: number; content: unknown }[] };
    if (result.notice) console.error(result.notice);
    if (result.tip) console.error(result.tip);
    for (const row of result.queue ?? []) console.log(`${row.number}. ${typeof row.content === "string" ? row.content : JSON.stringify(row.content)}`);
    if (result.job) watchSideJob(id, result.job.id);
    return;
  }
  let buf = "", printed = false;
  const dec = new TextDecoder();
  for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(frame)?.[1];
      const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      if (!ev || !data) continue;
      let e: any; try { e = JSON.parse(data); } catch { continue; }
      if (ev === "submitted") {
        if (e.notice) console.error(e.notice);
        if (e.tip) console.error(e.tip);
      }
      else if (ev === "message_update") {
        for (const c of e.changes ?? []) if (c.type === "text_delta") { process.stdout.write(c.delta); printed = true; }
      }
      else if (ev === "tool_execution_start") process.stderr.write(`\n  [tool] ${e.toolName}\n`);
      else if (ev === "done") {
        if (e.status !== "done") process.stderr.write(`\n[${e.status}${e.reason ? `: ${e.reason}` : ""}]\n`);
        else if (!printed && e.answer) process.stdout.write(e.answer);
        process.stdout.write("\n");
        return;
      }
    }
  }
  process.stdout.write("\n");
}

try {
  session ??= await newSession();
  if (args.length) {
    await send(session, args.join(" "));
  } else {
    console.error(`session ${session} (/new, /quit, /btw <question>, /bg <task>, /review [focus], /learn <source> [objective])`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      const line = (await rl.question("> ").catch(() => "/quit")).trim();
      if (!line) continue;
      if (line === "/quit") break;
      if (line === "/new") { session = await newSession(); console.error(`session ${session}`); continue; }
      await send(session, line).catch((e) => console.error(String(e)));
    }
    rl.close();
    observer.abort();
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
