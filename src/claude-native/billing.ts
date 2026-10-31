// A completed overage response is already charged. Stop the loop before another generation.
import type { ProviderLimit } from "../provider-limits.js";

export const ALLOW_USAGE_CREDITS_ENV = "LUNA_CLAUDE_ALLOW_USAGE_CREDITS";
export const FATAL_BILLING_LIMIT: ProviderLimit = { kind: "fatal", windows: [] };

export interface ClaudeRateLimitInfo {
  isUsingOverage?: unknown;
  overageInUse?: unknown;
}

export function usageCreditsAllowed(env: NodeJS.ProcessEnv): boolean {
  return ["1", "true", "yes", "on"].includes((env[ALLOW_USAGE_CREDITS_ENV] ?? "").trim().toLowerCase());
}

export function chargedToUsageCredits(info: ClaudeRateLimitInfo): boolean {
  // Overage being enabled/allowed is not evidence that this response used it.
  return info.isUsingOverage === true || info.overageInUse === true;
}

export function usageCreditsChargeError(): string {
  return "Claude Code billing: this response used paid usage credits instead of plan limits. " +
    "Luna stopped before executing tools or sending another generation. The completed response may already be charged. " +
    "Disable extra usage in Claude account settings to prevent that first charge. " +
    `To permit paid usage credits in Luna, set ${ALLOW_USAGE_CREDITS_ENV}=1.`;
}

export function usageCreditsRejection(message: string): string | undefined {
  if (!/third-party apps now draw from your extra usage|out of extra usage|draws? from your usage credits/iu.test(message)) return;
  return "Claude Code billing: Anthropic requires usage credits for this request. Luna will not retry it automatically. " +
    "Check Claude account billing and plan limits. Original error: " + message;
}
