// In-process Claude Code transport: one CLI process group and one admitted API request per generation. POSIX only.
import { accessSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Admission } from "./admission.js";
import { chargedToUsageCredits, FATAL_BILLING_LIMIT, usageCreditsAllowed, usageCreditsChargeError, usageCreditsRejection } from "./billing.js";
import { claudeHeaderLimit, recordClaudeLimit, type ProviderLimit } from "../provider-limits.js";
import { CARRIER_TYPE, conversationToolPrefix, buildBody, conversationSessionId, nativeModel, prepareHistory, projection } from "./history.js";
import { ClaudeTransportError, type Block, type NativeRequest, type NativeResponse, type NativeToolCall } from "./types.js";

export const INSTALL_HINT = "Claude Code is not installed (no `claude` on PATH or in the usual install directories). " +
  "Install it with `npm install -g @anthropic-ai/claude-code` or set LUNA_CLAUDE_EXECUTABLE to the binary.";
export const LOGGED_OUT_HINT = "Claude Code is installed but has no usable login in the environment Luna runs it in. " +
  "Run `claude auth login`, set CLAUDE_CODE_OAUTH_TOKEN in Luna's environment, or point " +
  "CLAUDE_CONFIG_DIR at a logged-in directory.";

const UPSTREAM = "https://api.anthropic.com";
const DRAIN_GRACE_MS = 10_000;
// Native's own codes for errors it answers without a relayed API status.
const NATIVE_ERROR_STATUS: Record<string, number> = {
  rate_limit: 429, billing_error: 402, authentication_failed: 401, overloaded: 529, server_error: 503,
};
const CONFLICT_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY"];
const BACKEND_KEYS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
const QUIET_ENV = {
  CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
  DISABLE_AUTOUPDATER: "1", DISABLE_FEEDBACK_COMMAND: "1", CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  // Luna owns tools, budgets, retries and compaction. Native's token reminder would also break cached prefixes.
  ENABLE_TOOL_SEARCH: "false", CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_AUTO_COMPACT: "1", DISABLE_COMPACT: "1",
  CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
  // Luna owns context: native must not read @-mentioned files, CLAUDE.md, or auto-memory into the request.
  CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
};
const INERT_MCP = fileURLToPath(new URL("./inert-mcp.mjs", import.meta.url));

type Json = Record<string, any>;

function aborted(): Error {
  return Object.assign(new Error("Claude request aborted"), { name: "AbortError" });
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
}

function which(name: string, path: string): string | undefined {
  if (name.includes("/")) return executable(name) ? name : undefined;
  return path.split(delimiter).filter(Boolean).map(dir => join(dir, name)).find(executable);
}

/** Absolute path, PATH lookup, then the usual install prefixes for a bare `claude`. */
function resolveClaude(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (isAbsolute(command)) return executable(command) ? command : undefined;
  const found = which(command, env.PATH || "/usr/bin:/bin");
  if (found || command !== "claude") return found;
  const home = env.HOME;
  const prefixes = [...(home ? [".local/bin", ".claude/local", "bin", ".npm-global/bin", ".bun/bin", ".volta/bin"]
    .map(p => join(home, p)) : []), "/opt/homebrew/bin", "/usr/local/bin"];
  return which(command, prefixes.join(delimiter));
}

/**
 * Copy the daemon environment; refuse API-key or custom-backend fallback before anything spawns.
 * An explicit environment (offline qualification only) is used as given.
 */
function childEnvironment(explicit?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...(explicit ?? process.env) };
  delete env.CLAUDECODE;
  if (!explicit) {
    const conflicts = CONFLICT_KEYS.filter(key => env[key]);
    conflicts.push(...BACKEND_KEYS.filter(key => !["", "0", "false", "no", "off"].includes((env[key] ?? "").toLowerCase())));
    if (conflicts.length) throw new Error("OAuth provider refuses conflicting native auth/backend overrides: " + conflicts.join(", "));
  }
  // Without USER a logged-in CLI reports loggedIn: false under supervisors that strip it.
  let user = env.USER;
  if (!user) try { user = userInfo().username; } catch { /* no passwd entry */ }
  if (user) { env.USER ??= user; env.LOGNAME ??= user; }
  if (env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR.replace(/^~(?=$|\/)/, homedir());
  // An inherited effort or extra body would override the request Luna built.
  delete env.CLAUDE_CODE_EXTRA_BODY;
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  return Object.assign(env, QUIET_ENV);
}

/** Resolve control-only requests with the same OAuth-only environment as generations. */
export function claudeControlOptions() {
  const env = childEnvironment();
  const executable = resolveClaude(process.env.LUNA_CLAUDE_EXECUTABLE ?? "claude", env);
  if (!executable) throw new Error(INSTALL_HINT);
  return { executable, env };
}

function privateDir(path: string): boolean {
  const info = lstatSync(path);
  return info.isDirectory() && info.uid === process.getuid!() && !(info.mode & 0o077);
}

/** Close a fresh directory through a no-follow descriptor; some filesystems return 0770 for a 0700 mkdir. */
function createPrivate(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fchmodSync(fd, 0o700); } finally { closeSync(fd); }
  } catch { /* privateDir decides */ }
}

let processCwd: string | undefined;
/**
 * One native cwd for every request of this OS user. Native writes its cwd into the environment message
 * near the top of every request, so a moving cwd moves the whole cache prefix.
 */
function workdir(): string {
  const now = new Date();
  const shared = join(tmpdir(), `claude-directsdk-cwd-${process.getuid!()}`);
  try {
    const parent = statSync(dirname(shared)).mode;
    if (!(parent & 0o022) || parent & 0o1000) {
      createPrivate(shared);
      if (privateDir(shared)) { utimesSync(shared, now, now); return shared; }
    }
  } catch { /* fall back to a private per-process directory */ }
  try {
    if (processCwd) {
      createPrivate(processCwd);
      if (privateDir(processCwd)) { utimesSync(processCwd, now, now); return processCwd; }
    }
  } catch { /* recreate below */ }
  const created = mkdtempSync(join(tmpdir(), "claude-directsdk-cwd-"));
  processCwd = created;
  process.once("exit", () => rmSync(created, { recursive: true, force: true }));
  return created;
}

const END = Symbol("end");
type Event = Json | typeof END;

/** Line-delimited stream-json reader with a per-event idle deadline. */
class Events {
  private items: (Event | Error)[] = [];
  private buffer = "";
  private wake: (() => void) | undefined;

  constructor(child: Bun.Subprocess<"pipe", "pipe", "pipe">, private readonly tail: () => string) {
    void (async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          this.buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = this.buffer.indexOf("\n")) >= 0) {
            this.push(this.buffer.slice(0, newline));
            this.buffer = this.buffer.slice(newline + 1);
          }
        }
        this.buffer += decoder.decode();
      } catch {
        // Stream closed or aborted; exited/END will follow.
      } finally {
        reader.releaseLock();
        await child.exited.catch(() => {});
        if (this.buffer.trim()) this.push(this.buffer);
        this.buffer = "";
        this.items.push(END);
        this.notify();
      }
    })();
  }

  private push(line: string) {
    try { this.items.push(JSON.parse(line) as Json); }
    catch {
      // The offending line is the whole diagnosis (a shim banner, a stray print).
      this.items.push(new Error(`Invalid native stream-json output: ${JSON.stringify(line.slice(0, 300))}${this.tail()}`));
    }
    this.notify();
  }

  notify() { const wake = this.wake; this.wake = undefined; wake?.(); }

  async next(timeoutMs: number, signal?: AbortSignal): Promise<Event> {
    const deadline = Date.now() + timeoutMs;
    while (!this.items.length) {
      if (signal?.aborted) throw aborted();
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("Claude request timed out");
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, left);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
    }
    if (signal?.aborted) throw aborted();
    const item = this.items.shift()!;
    if (item instanceof Error) throw item;
    return item;
  }
}

/** A clean admitted answer returns at native's result event; a slow native exit is drained afterwards. */
function fastEligible(result: Json, admission: Admission, stopped: boolean, nativeError: string | undefined): boolean {
  const message = admission.capture.message as { stop_reason?: string; content?: Block[] } | undefined;
  return admission.used && admission.status === 200 && admission.capture.complete && stopped &&
    nativeError === undefined && admission.denied === 0 && message?.stop_reason !== "refusal" &&
    ((result.subtype === "success" && !result.is_error) ||
      (result.subtype === "error_max_turns" && (message?.content ?? []).some((b: Block) => b.type === "tool_use")));
}

export interface RunOptions {
  executable: string;
  signal?: AbortSignal;
  onText: (text: string) => void;
  onThinking: (text: string) => void;
  /** Longest silence between native events, and the per-socket admission timeout. */
  timeoutMs?: number;
  /** Offline qualification only: a complete child environment whose ANTHROPIC_BASE_URL is the relay's target. */
  env?: NodeJS.ProcessEnv;
}

interface PreparedRun {
  root: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  admission: Admission;
  frames: ReturnType<typeof prepareHistory>["frames"];
  toolPrefix: string;
  lunaNames: Map<string, string>;
}

async function prepareRun(request: NativeRequest, options: RunOptions): Promise<PreparedRun> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const toolPrefix = conversationToolPrefix(request.messages);
  const { body, manifest, names, replayMetadata } = buildBody(request, toolPrefix);
  const { system, frames, assistantBoundaries } = prepareHistory(request.messages, names, toolPrefix);
  // A legacy signed carrier can restore several native messages for one Luna assistant.
  const nativeReplay = replayMetadata ? { ...replayMetadata,
    systemInjections: replayMetadata.systemInjections?.map(injection => {
      if (injection.beforeAssistant === null) return injection;
      const beforeAssistant = assistantBoundaries[injection.beforeAssistant];
      if (beforeAssistant === undefined) throw new Error("Claude tool history has an invalid assistant boundary");
      return { ...injection, beforeAssistant };
    }) } : undefined;
  const env = childEnvironment(options.env);
  const upstream = (options.env && env.ANTHROPIC_BASE_URL) || UPSTREAM;
  const command = resolveClaude(options.executable, env);
  if (!command) throw new ClaudeTransportError(INSTALL_HINT, 503);
  const lunaNames = new Map([...names].map(([luna, native]) => [native, luna]));

  // The queried frame lets the relay keep the cache breakpoint off native's per-request context.
  const lunaText = frames.filter(frame => frame.type === "user").flatMap(frame => frame.message.content)
    .flatMap(block => block.type === "text" && typeof block.text === "string" ? [block.text] : []);
  const admission = await Admission.open(upstream, timeoutMs, frames.at(-1)!.message.content, nativeReplay, lunaText);
  const root = mkdtempSync(join(tmpdir(), "claude-directsdk-"));
  try {
    writeFileSync(join(root, "tools.json"), JSON.stringify(manifest));
    // Settings apply env inside native, avoiding execve's per-string limit for full tool schemas.
    writeFileSync(join(root, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: body } }));
    writeFileSync(join(root, "system.md"), system);
    env.ANTHROPIC_BASE_URL = admission.url;
    if (request.max_tokens !== undefined) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(request.max_tokens);
    // Match the selected wire namespace without rewriting signed history.
    const serverName = toolPrefix.slice("mcp__".length, -"__".length);
    const mcp = { mcpServers: { [serverName]: { command: process.execPath, args: [INERT_MCP, join(root, "tools.json")] } } };
    const args = ["-p", "--model", nativeModel(request.model), "--input-format", "stream-json",
      "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", "",
      "--system-prompt-file", join(root, "system.md"), "--settings", join(root, "settings.json"),
      "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--max-turns", "1",
      "--permission-mode", "dontAsk", "--no-session-persistence", "--mcp-config", JSON.stringify(mcp),
      // One native session per conversation: its scratchpad path sits near the top of every request.
      "--session-id", conversationSessionId(system, frames)];
    return { root, command, args, env, admission, frames, toolPrefix, lunaNames };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    await admission.close().catch(() => {});
    throw error;
  }
}

class ProcessController {
  private child?: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private exited = false;
  private handedOff = false;
  private stderr: string[] = [];
  private events?: Events;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: NodeJS.ProcessEnv,
    private readonly admission: Admission,
    private readonly timeoutMs: number,
  ) {}

  tail = () => {
    const text = this.stderr.map(line => line.trim()).filter(Boolean).join(" ");
    return text ? ` (native stderr: ${text.slice(0, 400)})` : "";
  };

  // The npm shim and the inert MCP server run under native; kill the whole group, but only while we own the pid.
  killGroup = () => {
    if (!this.child?.pid || this.exited) return;
    try { process.kill(-this.child.pid, "SIGKILL"); } catch { /* ESRCH: gone; EPERM: zombie leader */ }
  };

  closed = (ms: number) => new Promise<void>(resolve => {
    if (!this.child || this.exited) return resolve();
    const timer = setTimeout(resolve, ms);
    void this.child.exited.catch(() => {}).finally(() => { clearTimeout(timer); resolve(); });
  });

  cancel = () => {
    this.admission.abort();
    this.killGroup();
    this.events?.notify();
  };

  spawnProcess(signal?: AbortSignal): Events {
    if (signal?.aborted) throw aborted();
    const spawned = this.child = Bun.spawn([this.command, ...this.args], {
      cwd: workdir(), env: this.env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true,
    });
    void spawned.exited.then(
      () => { this.exited = true; },
      error => {
        this.exited = true;
        if (error instanceof Error) this.stderr.push(error.message);
      },
    );
    void (async () => {
      const reader = spawned.stderr.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          this.stderr.push(...chunk.split("\n"));
          this.stderr.splice(0, Math.max(0, this.stderr.length - 40));
        }
      } catch {
        // Ignore stderr read errors on shutdown.
      } finally {
        reader.releaseLock();
      }
    })();
    return this.events = new Events(spawned, this.tail);
  }

  async sendFrames(frames: PreparedRun["frames"], reader: Events, signal?: AbortSignal): Promise<void> {
    const spawned = this.child!;
    const send = (line: string) => new Promise<void>((resolve, reject) => {
      // A child that stops reading stdin would block past the timeout: kill it then.
      const timer = setTimeout(() => { this.cancel(); reject(new Error("Claude request timed out")); }, this.timeoutMs);
      try {
        Promise.resolve(spawned.stdin.write(line))
          .then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });

    // Historical user frames replay without querying; only the newest user/tool-result frame queries.
    for (const [index, frame] of frames.entries()) {
      const replayed = frame.type === "user" && index < frames.length - 1;
      await send(JSON.stringify(replayed ? { ...frame, shouldQuery: false } : frame) + "\n");
      if (signal?.aborted) throw aborted();
      if (!replayed) continue;
      for (;;) {
        const ack = await reader.next(this.timeoutMs, signal);
        if (ack === END) throw new Error("Native exited before replay acknowledgment" + this.tail());
        if (ack.type !== "result") continue;
        if (ack.num_turns !== 0 || ack.is_error) throw new Error("Native history replay not supported: expected zero-turn acknowledgment");
        break;
      }
    }
    spawned.stdin.end();
  }

  async finish(fast: boolean): Promise<number | null> {
    if (fast) {
      // The answer is complete. Late native requests stay behind the consumed admission until native exits.
      this.handedOff = true;
      void this.closed(DRAIN_GRACE_MS).then(() => { this.killGroup(); return this.closed(5000); })
        .then(() => this.admission.close()).catch(() => {});
      return null;
    }
    await this.closed(this.timeoutMs);
    if (!this.exited) throw new Error("Claude request timed out");
    return this.child?.exitCode ?? null;
  }

  async cleanup(): Promise<void> {
    if (!this.handedOff) {
      // Return only after the owned process group is gone and the relay is closed.
      this.killGroup();
      await this.closed(5000);
      await this.admission.close().catch(() => {});
    }
  }
}

interface EventCollectorState {
  assistants: Json[];
  results: Json[];
  stopped: boolean;
  emitted: string;
  fast: boolean;
  nativeError: string | undefined;
  nativeErrorCode: unknown;
  blockedWindows: Map<string, number | null>;
  usedUsageCredits: boolean;
}

async function collectEvents(
  reader: Events,
  admission: Admission,
  options: RunOptions,
  timeoutMs: number,
): Promise<EventCollectorState> {
  const { signal } = options;
  const assistants: Json[] = [];
  const results: Json[] = [];
  let stopped = false, emitted = "", fast = false;
  let nativeError: string | undefined, nativeErrorCode: unknown;
  const blockedWindows = new Map<string, number | null>();
  let usedUsageCredits = false;

  for (;;) {
    const event = await reader.next(timeoutMs, signal);
    if (event === END) break;
    if (event.type === "rate_limit_event" && event.rate_limit_info && typeof event.rate_limit_info === "object") {
      recordClaudeLimit(blockedWindows, event.rate_limit_info);
      usedUsageCredits ||= chargedToUsageCredits(event.rate_limit_info);
    }
    if (event.type === "assistant") {
      const info = event.api_error_params?.rate_limit_info;
      if (info && typeof info === "object") {
        recordClaudeLimit(blockedWindows, info);
        usedUsageCredits ||= chargedToUsageCredits(info);
      }
      if (event.error || event.message?.error) {
        nativeError = (event.message?.content ?? []).filter((b: Block) => b.type === "text")
          .map((b: Block) => b.text ?? "").join("\n");
        nativeErrorCode = event.error;
      } else assistants.push(event.message);
    } else if (event.type === "result") {
      results.push(event);
      if (fastEligible(event, admission, stopped, nativeError)) { fast = true; break; }
    } else if (event.type === "stream_event") {
      const native = event.event;
      if (native.type === "message_stop") stopped = true;
      const delta = native.delta ?? {};
      if (delta.type === "text_delta") { emitted += delta.text; options.onText(delta.text); }
      else if (delta.type === "thinking_delta") options.onThinking(delta.thinking);
    }
  }

  return {
    assistants, results, stopped, emitted, fast,
    nativeError, nativeErrorCode, blockedWindows, usedUsageCredits,
  };
}

interface BuildResponseParams {
  request: NativeRequest;
  prep: PreparedRun;
  state: EventCollectorState;
  exitCode: number | null;
  tail: () => string;
  onText: (text: string) => void;
}

function buildResponse(params: BuildResponseParams): NativeResponse {
  const { request, prep, state, exitCode, tail, onText } = params;
  const { admission, toolPrefix, lunaNames, env } = prep;
  let { assistants, stopped } = state;
  const { results, emitted, fast, nativeError, nativeErrorCode, blockedWindows, usedUsageCredits } = state;

  const limit = (status: number | undefined): ProviderLimit | undefined => {
    if (status === 401 || status === 402 || status === 403) return { kind: "fatal", windows: [] };
    if (status !== 429 && status !== 529 && !blockedWindows.size) return undefined;
    const reported = claudeHeaderLimit(admission.limitHeaders, Date.now());
    return { kind: "wait", windows: [
      ...reported.windows,
      ...[...blockedWindows].map(([id, resetAt]) => ({ id, resetAt })),
    ] };
  };

  if (admission.used) {
    if (admission.status !== 200 || !admission.capture.complete) {
      // Native's last error may be the admission denial; report the relay's upstream outcome.
      let first = `upstream outcome: status ${admission.status}, capture ${admission.capture.complete ? "complete" : "incomplete"}` +
        (admission.failure ? `, relay failure ${admission.failure}` : "") +
        (admission.retries ? `, relay retries ${admission.retries} after ${admission.retryCauses.join("; ")}` : "") +
        `, native retries denied: ${admission.denied}`;
      if (admission.errorText()) first += ", upstream said: " + admission.errorText().slice(0, 500);
      const status = admission.status !== undefined && admission.status >= 400 ? admission.status : undefined;
      // An accepted stream that ended early is transient; this wording is the one pi-ai's retry classifier knows.
      const cut = admission.status === 200 && !admission.capture.complete ? "the stream was interrupted: " : "";
      throw new ClaudeTransportError(`Incomplete upstream response (${cut}${first})` + (nativeError ? ": " + nativeError : ""), status, limit(status));
    }
    assistants = [admission.capture.message as Json];
    stopped = true;
  }
  const handled = admission.denied > 0 || (admission.used && assistants[0]?.stop_reason === "refusal");
  if (nativeError !== undefined && !handled) {
    if (nativeErrorCode === "authentication_failed" && !admission.used) {
      throw new ClaudeTransportError(`${LOGGED_OUT_HINT} (native: ${nativeError})${tail()}`, 401);
    }
    const status = NATIVE_ERROR_STATUS[String(nativeErrorCode)];
    throw new ClaudeTransportError("Native API error: " + nativeError, status, limit(status));
  }
  const terminal = results.at(-1);
  if (terminal?.is_error && (blockedWindows.size || terminal.api_error_status === 429 || terminal.api_error_status === 529)) {
    const status = typeof terminal.api_error_status === "number" ? terminal.api_error_status : 429;
    throw new ClaudeTransportError("Native usage limit: " + String(terminal.result ?? terminal.subtype), status, limit(status));
  }
  if (results.length !== 1 || !assistants.length || !stopped) {
    throw new Error("Incomplete native response: assistant, message_stop and one result required");
  }
  const final = results[0]!;
  const blocks: Block[] = assistants.flatMap(a => a.content);
  let calls: NativeToolCall[] = [];
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    // Native sometimes drops the prefix on an offered tool; carry the offered name so replay does not teach the slip.
    if (lunaNames.has(block.name as string)) block.name = toolPrefix + block.name;
    const wire = block.name as string;
    const name = wire.startsWith(toolPrefix) ? wire.slice(toolPrefix.length) : wire;
    calls.push({ id: block.id as string, type: "function",
      function: { name: lunaNames.get(name) ?? name, arguments: JSON.stringify(block.input) } });
  }
  const boundary = calls.length > 0 && final.subtype === "error_max_turns" && (fast || exitCode === 1);
  if (!boundary && !handled && ((!fast && exitCode !== 0) || final.is_error || final.subtype !== "success")) {
    const status = typeof final.api_error_status === "number" ? final.api_error_status : blockedWindows.size ? 429 : undefined;
    throw new ClaudeTransportError("Native request failed: " + String(final.subtype) + tail(), status, limit(status));
  }
  const usage = admission.used ? assistants[0]!.usage : final.usage;
  if (!usage || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
    throw new Error("Native result missing complete token usage");
  }
  // Native reports a cumulative process total. This process never resumes a saved transcript;
  // replayed history does not query, so its single final result prices only this generation.
  // Read it once (including tool-use/max-turn and handled refusal results), never sum results.
  const cost = final.total_cost_usd;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    throw new Error("Native result missing valid USD cost");
  }
  const text = blocks.filter(b => b.type === "text").map(b => (b.text as string | undefined) ?? "").join("");
  if (emitted !== text) {
    if (!text.startsWith(emitted)) throw new Error("Native final text differs from incremental stream");
    onText(text.slice(emitted.length));
  }
  const message: NativeResponse["choices"][number]["message"] & Json = {
    role: "assistant", content: text || null, tool_calls: calls.length ? calls : null,
    reasoning_content: blocks.filter(b => b.type === "thinking").map(b => (b.thinking as string | undefined) ?? "").join("") || null,
  };
  message.reasoning_details = [{ type: CARRIER_TYPE, version: 1, wirePrefix: toolPrefix, messages: assistants, projection: projection(message) }];
  // An API refusal is terminal. The cut-off call stays in the carrier but never becomes actionable.
  const refused = assistants.some(a => a.stop_reason === "refusal");
  if (refused) {
    const details = assistants.find(a => a.stop_details && typeof a.stop_details === "object")?.stop_details ?? {};
    const explanation = typeof details.explanation === "string" ? details.explanation.trim() : "";
    message.refusal = explanation || (typeof details.category === "string" && details.category
      ? `provider refusal category: ${details.category}` : null);
    message.tool_calls = null;
    calls = [];
  }
  // Luna-local: a complete first call can precede a truncated batch; the limit reason wins so none execute.
  const truncated = assistants.some(a => a.stop_reason === "max_tokens" || a.stop_reason === "model_context_window_exceeded");
  const finish = refused ? "content_filter" : truncated ? "length" : calls.length ? "tool_calls" : "stop";
  const nativeAdmission: NonNullable<NativeResponse["usage"]["native_admission"]> = {
    upstream_requests: Number(admission.used), blocked_requests: admission.denied, request_id: admission.requestId ?? null,
  };
  if (admission.unrestored) nativeAdmission.unrestored = admission.unrestored;
  return {
    id: assistants.at(-1)?.id ?? "claude-native", model: request.model,
    choices: [{ finish_reason: finish, message }],
    usage: { native_cost_usd: cost, native_usage: usage, native_admission: nativeAdmission,
      ...(usedUsageCredits && !usageCreditsAllowed(env) ? { native_billing_error: usageCreditsChargeError() } : {}) },
  };
}

export async function runClaude(request: NativeRequest, options: RunOptions): Promise<NativeResponse> {
  const { signal } = options;
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (signal?.aborted) throw aborted();

  const prep = await prepareRun(request, options);
  const controller = new ProcessController(prep.command, prep.args, prep.env, prep.admission, timeoutMs);
  const cancel = controller.cancel;
  signal?.addEventListener("abort", cancel, { once: true });

  let usedUsageCredits = false;
  try {
    const reader = controller.spawnProcess(signal);
    await controller.sendFrames(prep.frames, reader, signal);
    const state = await collectEvents(reader, prep.admission, options, timeoutMs);
    usedUsageCredits = state.usedUsageCredits;
    const exitCode = await controller.finish(state.fast);
    if (signal?.aborted) throw aborted();
    return buildResponse({ request, prep, state, exitCode, tail: controller.tail, onText: options.onText });
  } catch (error) {
    if (signal?.aborted) throw error;
    const billing = usedUsageCredits && !usageCreditsAllowed(prep.env) ? usageCreditsChargeError()
      : usageCreditsRejection(error instanceof Error ? error.message : String(error));
    if (billing) throw new ClaudeTransportError(billing, 402, FATAL_BILLING_LIMIT);
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    rmSync(prep.root, { recursive: true, force: true });
    await controller.cleanup();
  }
}
