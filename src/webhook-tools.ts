// Agent tools for webhooks. Secrets never enter the transcript: the user reads them in Settings > Webhooks.
import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { OUT_EVENTS, WebhookError, type Webhooks } from "./webhooks.js";
import { StringEnum } from "./string-enum.js";

const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
const when = (ms: number | null) => (ms === null ? "never" : new Date(ms).toISOString());
const KIND = StringEnum(["inbound", "outbound"]);

async function guard(fn: () => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) {
  try { return await fn(); } catch (e) {
    if (e instanceof WebhookError) return text(e.message, true);
    throw e;
  }
}

/** Tools: webhook_list, webhook_create, webhook_update, webhook_remove, webhook_test, webhook_log. */
export function createWebhookExtension(get: () => Webhooks | undefined) {
  const need = () => { const w = get(); if (!w) throw new WebhookError(404, "webhooks are unavailable"); return w; };

  const list = defineTool({
    name: "webhook_list",
    description: "List inbound webhooks (URL path, target, filter) and outbound subscriptions (URL, events, format).",
    parameters: Type.Object({}),
    replay: "safe",
    async execute() {
      return guard(() => {
        const w = need();
        const ins = w.store.listInbound().map(h => `in#${h.id} "${h.name}" ${h.enabled ? "on" : "off"} POST /hooks/${h.slug} verify=${h.verify} -> ${h.target.kind} ${h.target.id}` +
          ` events=${h.events.length ? h.events.join(",") : "all"} received=${h.received} last=${when(h.lastAt)}${h.template ? " (template)" : ""}`);
        const outs = w.store.listSubs().map(s => `out#${s.id} "${s.name}" ${s.enabled ? "on" : "off"} ${s.format} ${s.url} events=${s.events.length ? s.events.join(",") : "all"}`);
        return text([`inbound (${ins.length}):`, ...ins, `outbound (${outs.length}):`, ...outs].join("\n"));
      });
    },
  });

  const create = defineTool({
    name: "webhook_create",
    description:
      "Create a webhook. inbound: external services POST to /hooks/<slug>; the payload goes to target " +
      "(session id = that session, project id = a new session in the project per call (0 = General), cron id = run that job). " +
      "verify: hmac (GitHub-style X-Hub-Signature-256) or token. events filters by event name, e.g. pull_request or pull_request.opened. " +
      "template uses {{body.path}}, {{event}}, {{action}}, {{payload}}. outbound: Luna POSTs events to url. " +
      `Events: ${OUT_EVENTS.join(", ")} (or session.*, cron.*). Formats: json, ntfy, discord, slack. ` +
      "Secrets are not returned: the user copies them from Settings > Webhooks.",
    parameters: Type.Object({
      kind: KIND,
      name: Type.String(),
      target: Type.Optional(Type.Object({ kind: StringEnum(["session", "project", "cron"]), id: Type.Number() })),
      verify: Type.Optional(StringEnum(["hmac", "token"])),
      template: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      format: Type.Optional(StringEnum(["json", "ntfy", "discord", "slack"])),
      events: Type.Optional(Type.Array(Type.String())),
    }),
    // A replay would create a second hook with a new secret.
    replay: "unsafe",
    async execute(a) {
      return guard(async () => {
        const w = need();
        if (a.kind === "inbound") {
          if (!a.target) return text("inbound webhooks need a target", true);
          await w.checkTarget(a.target);
          const { hook } = w.store.createInbound({ name: a.name, target: a.target, verify: a.verify, template: a.template, events: a.events });
          return text(`created in#${hook.id} "${hook.name}": POST <daemon URL>/hooks/${hook.slug} (verify=${hook.verify}) -> ${hook.target.kind} ${hook.target.id}. ` +
            "The secret is in Settings > Webhooks; the daemon must be reachable from the sender.");
        }
        if (!a.url) return text("outbound webhooks need a url", true);
        const { sub } = w.store.createSub({ name: a.name, url: a.url, events: a.events, format: a.format });
        return text(`created out#${sub.id} "${sub.name}" -> ${sub.url} (${sub.format}) events=${sub.events.length ? sub.events.join(",") : "all"}. ` +
          `Its signing secret is in Settings > Webhooks. Use webhook_test kind=outbound id=${sub.id} to send a test.`);
      });
    },
  });

  const update = defineTool({
    name: "webhook_update",
    description: "Change a webhook. Pass only fields to change: name, enabled, events, and for inbound target/verify/template, for outbound url/format.",
    parameters: Type.Object({
      kind: KIND, id: Type.Number(),
      name: Type.Optional(Type.String()), enabled: Type.Optional(Type.Boolean()), events: Type.Optional(Type.Array(Type.String())),
      target: Type.Optional(Type.Object({ kind: StringEnum(["session", "project", "cron"]), id: Type.Number() })),
      verify: Type.Optional(StringEnum(["hmac", "token"])), template: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      format: Type.Optional(StringEnum(["json", "ntfy", "discord", "slack"])),
    }),
    replay: "safe",
    async execute({ kind, id, ...patch }) {
      return guard(async () => {
        const w = need();
        if (kind === "inbound") {
          if (patch.target) await w.checkTarget(patch.target);
          const h = w.store.updateInbound(id, patch);
          return text(`updated in#${h.id} "${h.name}" ${h.enabled ? "on" : "off"} -> ${h.target.kind} ${h.target.id}`);
        }
        const s = w.store.updateSub(id, patch);
        return text(`updated out#${s.id} "${s.name}" ${s.enabled ? "on" : "off"} -> ${s.url}`);
      });
    },
  });

  const remove = defineTool({
    name: "webhook_remove",
    description: "Delete a webhook and its log. Senders that still call an inbound URL get 404.",
    parameters: Type.Object({ kind: KIND, id: Type.Number() }),
    replay: "safe",
    async execute({ kind, id }) {
      return guard(() => {
        const w = need();
        const ok = kind === "inbound" ? w.store.removeInbound(id) : w.store.removeSub(id);
        return text(ok ? `removed ${kind === "inbound" ? "in" : "out"}#${id}` : `no such ${kind} webhook ${id}`, !ok);
      });
    },
  });

  const test = defineTool({
    name: "webhook_test",
    description: "Send a webhook.test event to an outbound subscription now and report the result.",
    parameters: Type.Object({ id: Type.Number() }),
    replay: "unsafe",
    async execute({ id }) {
      return guard(async () => {
        const w = need();
        const d = w.test(id);
        await w.flush();
        const r = w.store.getDelivery(d.id)!;
        return text(r.status === "ok" ? `test delivered: HTTP ${r.responseStatus}` : `test failed: ${r.error ?? "unknown error"}${r.status === "pending" ? " (will retry)" : ""}`, r.status !== "ok");
      });
    },
  });

  const log = defineTool({
    name: "webhook_log",
    description: "Recent activity of one webhook: received calls for inbound, delivery attempts for outbound.",
    parameters: Type.Object({ kind: KIND, id: Type.Number(), limit: Type.Optional(Type.Number({ description: "default 20" })) }),
    replay: "safe",
    async execute({ kind, id, limit }) {
      return guard(() => {
        const w = need(), n = Math.min(Math.max(limit ?? 20, 1), 100);
        if (kind === "inbound") {
          if (!w.store.getInbound(id)) return text(`no such inbound webhook ${id}`, true);
          const rows = w.store.inboundLog(id, n);
          return text(rows.length ? rows.map(r => `${when(r.at)} ${r.outcome}${r.event ? ` ${r.event}` : ""}${r.sessionId ? ` session=${r.sessionId}` : ""}${r.detail ? ` (${r.detail})` : ""}`).join("\n") : "no calls yet");
        }
        if (!w.store.getSub(id)) return text(`no such outbound webhook ${id}`, true);
        const rows = w.store.deliveries(id, n);
        return text(rows.length ? rows.map(r => `#${r.id} ${when(r.createdAt)} ${r.event} ${r.status} attempts=${r.attempts}${r.responseStatus ? ` HTTP ${r.responseStatus}` : ""}${r.error ? ` (${r.error})` : ""}${r.status === "pending" ? ` next=${when(r.nextAt)}` : ""}`).join("\n") : "no deliveries yet");
      });
    },
  });

  return defineExtension({ name: "webhooks", tools: [list, create, update, remove, test, log] });
}
