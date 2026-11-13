/** Best-effort credential redaction for notes you type on a card. */
export function redact(s: string): string {
  return s
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}=*/g, "$1 [secret]")
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|glpat)[-_][A-Za-z0-9_-]{8,}/g, "[secret]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[secret]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[secret]")
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key|authorization)\b(\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi, "$1$2[secret]")
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, "[secret]");
}
