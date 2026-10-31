// Persist provider quota metadata in pi-ai's supported diagnostic channel, not in model-visible text.
import type { AssistantMessage } from "@earendil-works/pi-ai";

export const LIMIT_DIAGNOSTIC = "luna.usage-limit";
export type ProviderLimit = {
  kind: "wait" | "fatal";
  windows: { id: string; resetAt: number | null }[];
  receivedAt?: number;
  response?: string;
};

export function epochReset(seconds: unknown): number | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && seconds * 1000 <= 8.64e15
    ? seconds * 1000 : null;
}

/** Only a fully known set of blocked windows has an exact recovery time. */
export function latestLimitReset(limit: ProviderLimit): number | undefined {
  if (!limit.windows.length || limit.windows.some(w => w.resetAt === null)) return undefined;
  return limit.windows.reduce((latest, w) => Math.max(latest, w.resetAt!), 0);
}

export function readProviderLimit(message: Pick<AssistantMessage, "diagnostics">): ProviderLimit | undefined {
  const details = message.diagnostics?.findLast(d => d.type === LIMIT_DIAGNOSTIC)?.details as Record<string, unknown> | undefined;
  if (!details || (details.kind !== "wait" && details.kind !== "fatal") || !Array.isArray(details.windows)) return undefined;
  if (!details.windows.every(w => w !== null && typeof w === "object" && !Array.isArray(w) &&
    typeof w.id === "string" && (w.resetAt === null || typeof w.resetAt === "number" && Number.isFinite(w.resetAt) && w.resetAt > 0 && w.resetAt <= 8.64e15))) return undefined;

  let receivedAt: number | undefined;
  if (typeof details.receivedAt === "number" && Number.isFinite(details.receivedAt) && details.receivedAt > 0 && details.receivedAt <= 8.64e15) {
    receivedAt = details.receivedAt;
  }

  let response: string | undefined;
  if (typeof details.response === "string" && details.response.length <= 4000) {
    response = details.response;
  }

  return {
    kind: details.kind,
    windows: details.windows as ProviderLimit["windows"],
    ...(receivedAt !== undefined ? { receivedAt } : {}),
    ...(response !== undefined ? { response } : {}),
  };
}

/** Track only rejected Claude windows. Allowed overage must not block continuation. */
export function recordClaudeLimit(windows: Map<string, number | null>, info: {
  status?: unknown; rateLimitType?: unknown; resetsAt?: unknown; overageStatus?: unknown;
  isUsingOverage?: unknown; overageInUse?: unknown;
}): void {
  const id = typeof info.rateLimitType === "string" ? info.rateLimitType : "unknown";
  const allowed = info.status === "allowed" || info.status === "allowed_warning" ||
    info.overageStatus === "allowed" || info.overageStatus === "allowed_warning" ||
    info.isUsingOverage === true || info.overageInUse === true;
  if (allowed) windows.delete(id);
  else if (info.status === "rejected") windows.set(id, epochReset(info.resetsAt));
}

/** The relay keeps only quota headers, never authentication or arbitrary response headers. */
export function claudeHeaderLimit(headers: Record<string, string>, now: number): ProviderLimit {
  const windows = new Map<string, number | null>();
  for (const [name, status] of Object.entries(headers)) {
    if (!/^anthropic-ratelimit-.*-status$/.test(name) || status !== "rejected") continue;
    const prefix = name.slice(0, -"-status".length);
    windows.set(prefix, epochReset(Number(headers[`${prefix}-reset`])));
  }
  // Retry-After is a response delay, not evidence that another blocked window has reset.
  const retry = headers["retry-after"];
  if (retry !== undefined) {
    const delay = Number(retry);
    const at = retry.trim() && Number.isFinite(delay) && delay >= 0 ? now + delay * 1000 : Date.parse(retry);
    if (Number.isFinite(at) && at > 0 && at <= 8.64e15) windows.set("retry-after", at);
  }
  return { kind: "wait", windows: [...windows].map(([id, resetAt]) => ({ id, resetAt })) };
}
