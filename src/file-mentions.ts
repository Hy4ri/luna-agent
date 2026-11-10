// `@file:<path>` mentions. The composer completes paths on the session's execution machine (its working directory by
// default; a typed `~/…`, `/…` or `../…` path browses that directory instead). The prompt gets a "Referenced files"
// block with path, kind and size only. The model reads the content with `read`.
import { defineExtension, section, type ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord/context";
import { ExecTarget } from "./workers.js";

export interface FileMentionEntry { name: string; path: string; kind: "file" | "directory"; size: number }

const MAX_ENTRIES = 50;
const textOf = (content: unknown): string =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.map((b: { type?: string; text?: string }) => (b.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n") : "";

/** `@file:<path>` tokens in user messages, newest message first, without duplicates. A path has no whitespace. */
export function mentionedFilePaths(messages: readonly { role?: string; content?: unknown }[]): string[] {
  const paths: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    for (const match of textOf(m.content).matchAll(/(?:^|[^\w])@file:(\S+)/g)) {
      const path = match[1]!.replace(/[.,;:!?)\]}"']+$/, "");
      if (path && !paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

/** Expands a leading `~` against the machine's home directory. */
export function expandHome(path: string, home: string | undefined): string | undefined {
  if (path !== "~" && !path.startsWith("~/")) return path;
  if (!home) return undefined;
  return path === "~" ? home : `${home.replace(/\/+$/, "")}/${path.slice(2)}`;
}

/**
 * Entries for a typed query. No `/` in the query: the working directory, filtered by name. With a directory part
 * (`src/`, `~/x/`, `/etc/`): that directory, filtered by the rest. Each `path` is what the token carries: the typed
 * directory part plus the name, so `@file:~/x/` stays a `~/x/…` path.
 */
export async function completeFiles(env: ExecutionEnv, home: string | undefined, query: string, ctx: Context): Promise<{ entries: FileMentionEntry[]; error?: string }> {
  const slash = query.lastIndexOf("/");
  const typedDir = query.slice(0, slash + 1);
  const needle = query.slice(slash + 1).toLowerCase();
  const dir = typedDir ? expandHome(typedDir, home) : ".";
  if (dir === undefined) return { entries: [], error: "home directory unknown on this machine" };
  const abs = await env.absolutePath(dir, ctx);
  if (!abs.ok) return { entries: [], error: abs.error.message };
  const listed = await env.listDir(abs.value, ctx);
  if (!listed.ok) return { entries: [], error: listed.error.message };
  const entries = listed.value
    .filter(e => (e.kind === "file" || e.kind === "directory" || e.kind === "symlink") && !/\s/.test(e.name))
    .filter(e => (needle.startsWith(".") || !e.name.startsWith(".")) && e.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory")
      || Number(b.name.toLowerCase().startsWith(needle)) - Number(a.name.toLowerCase().startsWith(needle))
      || a.name.localeCompare(b.name))
    .slice(0, MAX_ENTRIES)
    .map(e => ({ name: e.name, path: typedDir + e.name, kind: e.kind === "directory" ? "directory" as const : "file" as const, size: e.size }));
  return { entries };
}

const human = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/** Adds the "Referenced files" block for `@file:` tokens. `home` gives the home directory of the session's machine. */
export function createFileMentionExtension(o: { home: (worker: number | null) => string | undefined }) {
  return defineExtension({
    name: "file-mentions",
    sections: [section("files", async (input, ctx) => {
      const runtime = input.read as { context?: (id: ConversationId, c: typeof ctx) => Promise<{ messages: readonly { role?: string; content?: unknown }[] }> };
      const view = typeof runtime.context === "function" ? await runtime.context(input.conversationId, ctx).catch(() => undefined) : undefined;
      const paths = view ? mentionedFilePaths(view.messages) : [];
      if (!paths.length || !input.env) return undefined;
      const worker = (await input.read.snapshot(ExecTarget, input.conversationId, ctx).catch(() => undefined))?.worker ?? null;
      const limit = 3000;
      const lines: string[] = [];
      for (const path of paths) {
        const resolved = expandHome(path, o.home(worker));
        const abs = resolved === undefined ? undefined : await input.env.absolutePath(resolved, ctx);
        const info = abs?.ok ? await input.env.fileInfo(abs.value, ctx) : undefined;
        const line = !abs?.ok || !info?.ok ? `@file:${path}: not found or not readable on this machine`
          : `@file:${path} -> ${abs.value}: ${info.value.kind === "directory" ? "directory" : `file, ${human(info.value.size)}`}`;
        if (lines.join("\n").length + line.length > limit - 300) { lines.push("[truncated: more referenced files; mention fewer files]"); break; }
        lines.push(line);
      }
      return ["Referenced files:", ...lines,
        "The content is not in this prompt. Read a file with `read` using the absolute path; list a directory with `ls` or `bash`."].join("\n");
    })],
  });
}
