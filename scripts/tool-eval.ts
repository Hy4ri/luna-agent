// Tool-selection eval against a running Luna daemon.
// Each task runs in a fresh session; the score is whether the model reached an acceptable tool, and how cleanly.
// Tasks are read-only or write only under the scratch directory. Sessions are deleted afterwards.
//
//   LUNA_TOKEN=... bun scripts/tool-eval.ts [--url http://127.0.0.1:8787] [--out result.json] [--only id,id] [--jobs 4]
//     [--model provider/modelId] [--keep]
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

type Task = {
  id: string; prompt: string;
  /** Acceptable tools; the task passes when any is called (codemode calls count by the tools its script names). */
  expect: string[];
  /** Optional extra check on the calls of an expected tool. */
  check?: (calls: Call[]) => boolean;
  /** The task also passes without a tool call when the final answer matches (the prompt may already hold the data). */
  answer?: RegExp;
};
/** inner: named inside a codemode script. */
type Call = { name: string; args: Record<string, unknown>; error: boolean; inner?: boolean };

/** The first call that does the work: skips tool_search (loading a deferred tool) and a codemode wrapper that names tools. */
const firstWork = (list: Call[]) => list.find((c, i) => c.name !== "tool_search" && !(c.name === "codemode" && list[i + 1]?.inner))?.name ?? null;

/** Text of the last assistant message. */
function finalText(entries: { model?: { role: string; content?: unknown }[] }[]): string {
  for (const e of [...entries].reverse()) for (const m of [...(e.model ?? [])].reverse()) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const text = (m.content as { type: string; text?: string }[]).filter(b => b.type === "text").map(b => b.text ?? "").join("");
    if (text) return text;
  }
  return "";
}

const SCRATCH = "/tmp/luna-tool-eval";
const tasks: Task[] = [
  { id: "read-head", prompt: `Show me the first 3 lines of ${SCRATCH}/notes.txt.`, expect: ["read"] },
  { id: "write-new", prompt: `Create ${SCRATCH}/out/hello.txt containing exactly "hello eval".`, expect: ["write", "bash"] },
  { id: "edit-word", prompt: `In ${SCRATCH}/edit-me.txt replace the word alpha with beta. Change nothing else.`, expect: ["edit"] },
  { id: "bash-cmd", prompt: "Run `uname -m` and tell me the result.", expect: ["bash"] },
  { id: "bash-bg", prompt: "Start `sleep 15; echo eval-done` as a background command and tell me its process id. Do not wait for it.", expect: ["bash"],
    check: c => c.some(x => x.name === "bash" && x.args.background === true) },
  { id: "proc-list", prompt: "List the background commands this chat owns.", expect: ["process_manage"] },
  { id: "grep-dir", prompt: `Which file under ${SCRATCH} contains the word gamma?`, expect: ["bash"] },
  { id: "multi-read", prompt: `Count the total lines across ${SCRATCH}/a.txt, ${SCRATCH}/b.txt and ${SCRATCH}/c.txt.`, expect: ["bash", "read", "codemode"] },
  { id: "web-search", prompt: "Search the web: what is the latest released version of the Bun JavaScript runtime?", expect: ["web"],
    check: c => c.some(x => x.name === "web" && x.args.action === "search") },
  { id: "web-read", prompt: "Read https://example.com and quote its main heading.", expect: ["web", "browser"] },
  { id: "web-json", prompt: "Fetch https://httpbin.org/json and tell me the slideshow title.", expect: ["web", "bash"] },
  { id: "browser-open", prompt: "Open https://example.com in the browser and take a screenshot of it.", expect: ["browser"],
    check: c => c.some(x => x.name === "browser" && x.args.action === "open") },
  { id: "browser-click", prompt: "In the browser, open https://example.com and click its only link. Tell me where you land.", expect: ["browser_act"] },
  { id: "media-image", prompt: `Describe the image ${SCRATCH}/pic.png.`, expect: ["media_analyze", "read"] },
  { id: "cron-list", prompt: "List my scheduled cron jobs.", expect: ["cron"], check: c => c.some(x => x.name === "cron" && x.args.action === "list") },
  { id: "cron-runs", prompt: "Show the most recent failed scheduled-job runs.", expect: ["cron"], check: c => c.some(x => x.name === "cron" && ["runs", "lessons"].includes(String(x.args.action))) },
  { id: "skill-list", prompt: "Which skills are installed? Just list their names.", expect: ["skill"], answer: /humanizer/i },
  { id: "skill-view", prompt: "Load the humanizer skill and summarize what it does in one sentence.", expect: ["skill"],
    check: c => c.some(x => x.name === "skill" && x.args.action === "view") },
  { id: "memory-search", prompt: "Search your saved memory for anything about the printer and tell me its IP.", expect: ["memory"] },
  { id: "session-search", prompt: "Search our past conversations for the Bun migration and tell me the session title.", expect: ["session_search"] },
  { id: "todo", prompt: "Make a todo list with three steps for writing a README. Do not do the steps.", expect: ["todo"] },
  { id: "board", prompt: "List the cards on the project board.", expect: ["board"] },
  { id: "machine", prompt: "Run `hostname` on the machine named main and tell me the output.", expect: ["machine_exec", "bash"] },
  { id: "ask", prompt: "Ask me a structured multiple-choice question: tabs or spaces?", expect: ["ask_user_question"] },
  { id: "delegate", prompt: `Spawn one subagent that counts the lines of ${SCRATCH}/notes.txt, and report its answer.`, expect: ["delegate_task"] },
  { id: "terminal", prompt: "Start an interactive python3 REPL in a real terminal, compute 2**10 in it, then exit.", expect: ["terminal"] },
  { id: "cloudflare", prompt: "Search the Cloudflare documentation: what is the maximum value size in Workers KV?", expect: ["cloudflare__docs"] },
  { id: "workspace", prompt: `Make ${SCRATCH}/out this session's active workspace.`, expect: ["session_workspace"] },
  { id: "goal", prompt: "What is this conversation's current goal status?", expect: ["goal"] },
  { id: "handoff", prompt: "You need my permission before you may delete anything. Mark that you are waiting for approval to delete /tmp/luna-tool-eval/out.", expect: ["session_handoff", "ask_user_question"] },
];

const { values: opt } = parseArgs({ options: {
  url: { type: "string", default: "http://127.0.0.1:8787" }, out: { type: "string" }, only: { type: "string" },
  jobs: { type: "string", default: "4" }, model: { type: "string" }, keep: { type: "boolean", default: false },
  timeout: { type: "string", default: "180" },
} });
const token = process.env.LUNA_TOKEN;
const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(opt.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

function scratch() {
  mkdirSync(`${SCRATCH}/out`, { recursive: true });
  writeFileSync(`${SCRATCH}/notes.txt`, "line one\nline two\nline three\nline four\nline five\n");
  writeFileSync(`${SCRATCH}/edit-me.txt`, "first alpha line\nsecond line\n");
  writeFileSync(`${SCRATCH}/a.txt`, "1\n2\n"); writeFileSync(`${SCRATCH}/b.txt`, "1\n2\n3\n"); writeFileSync(`${SCRATCH}/c.txt`, "gamma\n");
  // 16x16 solid red PNG.
  writeFileSync(`${SCRATCH}/pic.png`, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mM4w8BAEmIY1TCqYfhqAABBZ8wBpACLEwAAAABJRU5ErkJggg==", "base64"));
}

/** Tool calls in entry order, with codemode scripts expanded to the tools they name. */
function calls(entries: { model?: { role: string; content?: unknown; toolCallId?: string; isError?: boolean }[] }[]): Call[] {
  const out: (Call & { id?: string })[] = [];
  const errors = new Set<string>();
  for (const e of entries) for (const m of e.model ?? []) {
    if (m.role === "toolResult" && m.isError && m.toolCallId) errors.add(m.toolCallId);
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as { type: string; id?: string; name?: string; arguments?: Record<string, unknown> }[]) {
      if (b.type !== "toolCall" || !b.name) continue;
      out.push({ name: b.name, args: b.arguments ?? {}, error: false, id: b.id });
      if (b.name === "codemode") for (const [, name] of String(b.arguments?.code ?? "").matchAll(/tools\.([A-Za-z0-9_]+)\s*\(/g))
        out.push({ name: name!, args: {}, error: false, inner: true });
    }
  }
  return out.map(({ id, ...c }) => ({ ...c, error: !!id && errors.has(id) }));
}

async function run(task: Task) {
  const started = Date.now();
  const model = opt.model?.split("/");
  const { id } = await api("POST", "/v1/sessions", { cwd: SCRATCH, ...(model ? { model: { provider: model[0], modelId: model.slice(1).join("/") } } : {}) });
  try {
    await api("POST", `/v1/sessions/${id}/messages?async=1`, { content: task.prompt });
    let s: { running: boolean; status: string; entries: never[] } = { running: true, status: "", entries: [] };
    const deadline = started + Number(opt.timeout) * 1000;
    await Bun.sleep(2000);
    while (Date.now() < deadline) {
      s = await api("GET", `/v1/sessions/${id}?limit=200`);
      if (!s.running || ["needs_input", "needs_approval"].includes(s.status)) break;
      await Bun.sleep(2000);
    }
    const timedOut = s.running && !["needs_input", "needs_approval"].includes(s.status);
    if (s.running) await api("POST", `/v1/sessions/${id}/abort`).catch(() => {});
    const entries = [...s.entries].reverse();
    const list = calls(entries);
    const pass = (list.some(c => task.expect.includes(c.name)) && (!task.check || task.check(list)))
      || (!!task.answer && list.length === 0 && task.answer.test(finalText(entries)));
    return { id: task.id, session: id, pass, first: firstWork(list), calls: list.length, errors: list.filter(c => c.error).length,
      tools: list.map(c => c.name), timedOut, status: s.status, seconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    if (!opt.keep) await api("DELETE", `/v1/sessions/${id}`).catch(e => console.error(`cleanup ${id}: ${e}`));
  }
}

scratch();
const only = opt.only?.split(",");
const queue = tasks.filter(t => !only || only.includes(t.id));
const results: Awaited<ReturnType<typeof run>>[] = [];
await Promise.all(Array.from({ length: Number(opt.jobs) }, async () => {
  for (let t = queue.shift(); t; t = queue.shift()) {
    const r = await run(t).catch(e => ({ id: t!.id, session: 0, pass: false, first: null, calls: 0, errors: 0, tools: [], timedOut: false, status: `error: ${e}`, seconds: 0 }));
    results.push(r);
    console.log(`${r.pass ? "PASS" : "FAIL"} ${r.id.padEnd(15)} first=${r.first ?? "-"} calls=${r.calls} errors=${r.errors} ${r.timedOut ? "TIMEOUT " : ""}[${r.tools.join(",")}]`);
  }
}));
results.sort((a, b) => tasks.findIndex(t => t.id === a.id) - tasks.findIndex(t => t.id === b.id));
const summary = { passed: results.filter(r => r.pass).length, total: results.length,
  firstCallExpected: results.filter(r => r.first && tasks.find(t => t.id === r.id)!.expect.includes(r.first)).length,
  calls: results.reduce((n, r) => n + r.calls, 0), errors: results.reduce((n, r) => n + r.errors, 0), timeouts: results.filter(r => r.timedOut).length };
console.log(JSON.stringify(summary));
if (opt.out) writeFileSync(opt.out, JSON.stringify({ summary, results }, null, 2) + "\n");
process.exitCode = summary.passed === summary.total ? 0 : 1;
