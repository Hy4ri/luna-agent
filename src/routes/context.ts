import type { Context as HonoContext } from "hono";
import type { ConversationId, Tx, UserInput, AgentChange } from "@earendil-works/pi-durable";
import type { ServerOptions } from "../server.js";
import type { SideCommands, SideJob } from "../side-commands.js";
import { sideMedia } from "../side-media.js";
import type { UploadInput } from "../upload-input.js";
import { prepareUploadInput } from "../upload-input.js";
import { UploadError, type UploadMetadata } from "../uploads.js";
import { ExecTarget } from "../workers.js";
import { uploadWriter } from "../worker-protocol.js";
import { withAbortSignal } from "@earendil-works/chord/context";
import { context } from "../luna.js";
import { readLimitWait } from "../limit-continue.js";

export type Harness = ServerOptions["harness"];
export type ActiveConversation = NonNullable<Awaited<ReturnType<Harness["conversation"]>>>;

export type ErrFn = (
  c: HonoContext,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 502 | 503 | 504,
  message: string,
) => Response;

export interface RouteCtx {
  opts: ServerOptions;
  harness: Harness;
  sideCommands: SideCommands;
  err: ErrFn;
  getConv: (id: string) => Promise<ActiveConversation | undefined>;
  baseAgent: () => AgentChange;
  resumeAt: (tx: Tx, id: ConversationId, running: boolean) => Promise<number | null>;
  serial: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  stop: (conv: ActiveConversation) => Promise<void>;
  draining: Set<string>;
  jobView: (job: SideJob) => SideJob & {
    media: { name: string; mimeType: string; type: string; directive: string; url: string }[];
  };
  prepareAttachments: (input: UploadInput, conv: ActiveConversation, signal: AbortSignal) => Promise<UserInput>;
  send?: (
    c: HonoContext,
    sessionId: string,
    body: { content?: unknown; requestId?: string; whenBusy?: "steer" | "followUp" | "reject" | "redirect" },
    asyncMode?: boolean,
  ) => Promise<Response>;
}

export function createRouteCtx(
  opts: ServerOptions,
  err: ErrFn,
  sideCommands: SideCommands,
): RouteCtx {
  const { harness } = opts;
  const draining = new Set<string>();
  const stops = new Map<string, Promise<void>>();
  const admissions = new Map<string, Promise<unknown>>();

  const serial = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const previous = admissions.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    admissions.set(id, next);
    try {
      return await next;
    } finally {
      if (admissions.get(id) === next) admissions.delete(id);
    }
  };

  const stop = async (conv: ActiveConversation) => {
    const id = String(conv.id);
    const pending = stops.get(id);
    if (pending) return pending;
    draining.add(id);
    const work = serial(id, async () => {
      await opts.limitContinuer?.cancel(Number(conv.id), "Stopped by the user.");
      return conv.abort(context);
    });
    stops.set(id, work);
    try {
      await work;
    } finally {
      draining.delete(id);
      stops.delete(id);
    }
  };

  const resumeAt = async (tx: Tx, id: ConversationId, running: boolean) =>
    !running && opts.limitContinuer?.enabled() ? (await readLimitWait(tx, id))?.resumeAt ?? null : null;

  const jobView = (job: SideJob) => ({
    ...job,
    media: (job.kind === "bg" && job.status === "complete" ? sideMedia(job.text) : []).map(
      ({ name, mimeType, type, directive }, index) => ({
        name,
        mimeType,
        type,
        directive,
        url: `/v1/sessions/${encodeURIComponent(job.sessionId)}/side-jobs/${encodeURIComponent(job.id)}/media/${index}`,
      }),
    ),
  });

  const getConv = async (id: string) => {
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId) || numericId < 1) return undefined;
    // Storage IDs are numbers. String keys would survive numeric cache eviction on deletion.
    return harness.conversation(numericId as ConversationId, context);
  };

  const baseAgent = () => {
    const c = opts.settings?.resolved();
    return {
      ...(opts.agent ?? {}),
      ...(opts.providers && { model: opts.providers.defaultModel() }),
      ...(c?.thinkingLevel ? { thinkingLevel: c.thinkingLevel } : {}),
      ...(c?.maxTurns ? { maxTurns: c.maxTurns } : {}),
      ...(c?.instructions ? { instructions: c.instructions } : {}),
    };
  };

  const prepareAttachments = async (
    input: UploadInput,
    conv: ActiveConversation,
    signal: AbortSignal,
  ): Promise<UserInput> => {
    if (typeof input === "string" || input.every((block) => block.type === "text")) {
      return prepareUploadInput(input, opts.uploads);
    }
    const worker = (await harness.snapshot(ExecTarget, conv.id, context))?.worker;
    let copy: ((file: UploadMetadata) => Promise<UploadMetadata>) | undefined;
    if (worker) {
      if (!opts.workers?.store.get(worker)?.capabilities?.uploadFiles) {
        throw new UploadError(400, "This execution worker cannot store uploads. Update it to the same Luna version.");
      }
      const env = opts.workers.env(worker, (await conv.agent(context)).cwd);
      const writer = uploadWriter(env);
      if (!writer) throw new UploadError(500, "Worker upload storage is unavailable.");
      copy = async (file) => {
        if (!opts.uploads) throw new UploadError(500, "Upload storage is unavailable.");
        const result = await writer.writeUpload(
          { name: file.name, mimeType: file.mimeType, data: new Uint8Array(opts.uploads.read(file.id)) },
          withAbortSignal(signal, context),
        );
        if (!result.ok) throw new UploadError(500, `Could not copy the upload to its execution worker: ${result.error.message}`);
        const local = result.value;
        if (
          local.id !== file.id ||
          local.ref !== file.ref ||
          local.name !== file.name ||
          local.size !== file.size ||
          typeof local.path !== "string"
        ) {
          throw new UploadError(500, "The execution worker returned an invalid upload receipt.");
        }
        return local;
      };
    }
    return prepareUploadInput(input, opts.uploads, copy, signal, (file) =>
      harness.commit(() => {
        if (!opts.uploads) throw new UploadError(500, "Upload storage is unavailable.");
        return opts.uploads.put(file);
      }, context),
    );
  };

  return {
    opts,
    harness,
    sideCommands,
    err,
    getConv,
    baseAgent,
    resumeAt,
    serial,
    stop,
    draining,
    jobView,
    prepareAttachments,
  };
}

export function textOf(entry: { model?: readonly unknown[] } | undefined): string {
  const msg = entry?.model?.[0] as { content?: unknown } | undefined;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((b: { type?: string; text?: string }) => (b.type === "text" ? b.text : "")).join("");
  }
  return "";
}
