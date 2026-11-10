// Control-only usage reads: never submit a prompt or start a model generation.
import { spawn } from "node:child_process";
import { z } from "zod";
import type { UsageState } from "@earendil-works/pi-durable";
import { claudeControlOptions } from "./claude-native/transport.js";

const window = z.object({ utilization: z.number().finite().nullable(), resets_at: z.string().nullable() });
const reportSchema = z.object({
  subscription_type: z.string().nullable(),
  rate_limits_available: z.boolean(),
  rate_limits: z.object({
    five_hour: window.nullable().optional(),
    seven_day: window.nullable().optional(),
    seven_day_oauth_apps: window.nullable().optional(),
    seven_day_opus: window.nullable().optional(),
    seven_day_sonnet: window.nullable().optional(),
    model_scoped: z.array(window.extend({ display_name: z.string() })).optional(),
    extra_usage: z.object({ is_enabled: z.boolean(), utilization: z.number().finite().nullable() }).nullable().optional(),
  }).nullable(),
});
export type ClaudeUsageReport = z.infer<typeof reportSchema>;

export async function readClaudeUsage(signal?: AbortSignal): Promise<ClaudeUsageReport> {
  const { executable, env } = claudeControlOptions();
  if (signal?.aborted) throw new Error("Claude usage request cancelled.");
  const child = spawn(executable, ["--safe-mode", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--tools", "", "--no-session-persistence", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
  { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  // Always reap the process group, including native children, before returning.
  const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await new Promise<ClaudeUsageReport>((resolve, reject) => {
      let buffer = "", bytes = 0, requested = false;
      const fail = () => reject(new Error("Claude usage report is unavailable. Check Claude Code login and version."));
      const send = (request_id: string, request: object) => child.stdin.write(JSON.stringify({ type: "control_request", request_id, request }) + "\n");
      cancel = () => reject(new Error("Claude usage request cancelled."));
      signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => reject(new Error("Claude usage request timed out.")), 20_000);
      child.once("error", fail);
      child.once("exit", fail);
      child.stdin.on("error", fail);
      // Drain stderr without exposing CLI diagnostics or account information.
      child.stderr.resume();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2 * 1024 * 1024) { fail(); return; }
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const event = JSON.parse(line);
            if (event.type !== "control_response") continue;
            const response = event.response;
            if (response?.request_id === "luna-usage-init" && !requested) {
              if (response.subtype !== "success") { fail(); return; }
              requested = true;
              send("luna-usage-report", { subtype: "get_usage", skip_behaviors: true });
            } else if (response?.request_id === "luna-usage-report") {
              if (response.subtype !== "success") { fail(); return; }
              const parsed = reportSchema.safeParse(response.response);
              if (!parsed.success) { fail(); return; }
              resolve(parsed.data);
            }
          } catch { fail(); return; }
        }
      });
      send("luna-usage-init", { subtype: "initialize" });
    });
  } finally {
    clearTimeout(timer);
    if (cancel) signal?.removeEventListener("abort", cancel);
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
    }
    child.stdin.destroy();
    await closed;
  }
}

export function usageNotice(usage: UsageState, report?: ClaudeUsageReport): string {
  const totals = Object.values(usage.models).reduce((sum, value) => ({
    tokens: sum.tokens + value.totalTokens, cost: sum.cost + value.cost.total,
  }), { tokens: 0, cost: 0 });
  // Stock ledger sums keep the first response's totalFromProvider flag, so a session total is always an estimate.
  const lines = [`Luna session: ${totals.tokens.toLocaleString("en-US")} tokens · estimated cost $${totals.cost.toFixed(4)} (catalog rates, a CLI estimate, or mixed sources; not an invoice or your subscription bill).`];
  if (!report) return lines.join("\n");
  lines.push(`Claude plan (daemon host): ${report.subscription_type ?? "unavailable"}.`);
  if (!report.rate_limits_available || !report.rate_limits) {
    lines.push("Claude plan usage: unavailable.");
    return lines.join("\n");
  }
  const limits = report.rate_limits;
  const rows: [string, z.infer<typeof window> | null | undefined][] = [
    ["5-hour", limits.five_hour], ["Weekly", limits.seven_day], ["OAuth apps weekly", limits.seven_day_oauth_apps],
    ["Opus weekly", limits.seven_day_opus], ["Sonnet weekly", limits.seven_day_sonnet],
    ...(limits.model_scoped ?? []).map(row => [row.display_name, row] as [string, typeof row]),
  ];
  let shown = false;
  for (const [label, value] of rows) {
    if (!value) continue;
    shown = true;
    const reset = value.resets_at && Number.isFinite(Date.parse(value.resets_at)) ? new Date(value.resets_at).toISOString() : null;
    lines.push(`${label}: ${value.utilization === null ? "unavailable" : `${value.utilization}% used`}${reset ? ` · resets ${reset}` : ""}.`);
  }
  if (!shown) lines.push("Claude plan usage: unavailable.");
  if (limits.extra_usage) lines.push(`Extra usage: ${limits.extra_usage.is_enabled ? limits.extra_usage.utilization === null ? "enabled" : `${limits.extra_usage.utilization}% used` : "disabled"}.`);
  return lines.join("\n");
}
