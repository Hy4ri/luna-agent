// Role defaults are explicit tool allowlists. They do not install tools or grant new authority.
export interface DelegateProfile {
  provider?: string; model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  maxTurns?: number;
  context?: "fresh" | "fork";
  tools: string[];
  instructions?: string;
}
export const DEFAULT_DELEGATE_PROFILES: Record<string, DelegateProfile & { context: "fresh" | "fork" }> = {
  scout: { context: "fresh", tools: ["read", "delegate_files", "skill", "session_handoff"], instructions: "Inspect the assigned code and report relevant files and concrete evidence. You are read-only. Do not edit or run shell commands." },
  reviewer: { context: "fresh", tools: ["read", "delegate_files", "skill", "session_handoff"], instructions: "Review the assigned work independently. Report only concrete findings with file paths and lines. You are read-only. Do not edit, run commands, or claim that tests passed." },
  worker: { context: "fresh", tools: ["read", "write", "edit", "bash", "skill", "session_handoff"], instructions: "Implement only the assigned scope. Follow repository instructions. Report actual changes, validation, and limits. Escalate unapproved decisions with session_handoff." },
};
