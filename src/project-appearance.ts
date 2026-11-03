/** Persisted icon IDs shared by the API and web UI. Null means the default folder icon. */
export const PROJECT_ICONS = ["folder", "code", "terminal", "globe", "smartphone", "layers", "database", "book-open", "briefcase", "flask-conical", "rocket", "wrench"] as const;
export type ProjectIcon = typeof PROJECT_ICONS[number];
export type ProjectAppearance = { color?: string | null; icon?: string | null };

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const PROHIBITED_CHARS = /[\p{Cc}\p{Cs}\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** Checks if a custom icon is exactly one visible grapheme (rejecting control chars, bidi overrides, whitespace, or invisible/combining-mark-only chars). */
export function isValidCustomIcon(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (PROHIBITED_CHARS.test(value)) return false;
  const segments = Array.from(graphemeSegmenter.segment(value));
  if (segments.length !== 1) return false;
  // Must contain at least one visible base character (not purely controls, whitespace, format/bidi, combining marks, or default ignorable characters)
  const base = value.replace(/[\p{C}\p{Z}\p{M}\p{Default_Ignorable_Code_Point}]/gu, "");
  return base.length > 0;
}

/** Validates whether an icon string is a supported built-in Lucide icon id or a valid single visible grapheme. */
export function isValidProjectIcon(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if ((PROJECT_ICONS as readonly string[]).includes(value)) return true;
  return isValidCustomIcon(value);
}
