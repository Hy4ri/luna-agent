// Theme tokens that generated visuals may use. Inline content inherits them through the shadow
// boundary; the sandbox and Mermaid need literal values, so they are read from the live root.
export const THEME_TOKENS = [
  "background", "foreground", "card", "card-foreground", "primary", "primary-text", "primary-foreground",
  "secondary", "muted", "muted-foreground", "accent", "border", "input", "ring", "destructive",
  "success", "warning", "info", "violet", "mono", "radius",
  "chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6",
] as const;

export type Theme = Record<(typeof THEME_TOKENS)[number], string>;

export function readTheme(): Theme {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(THEME_TOKENS.map(t => [t, style.getPropertyValue(`--${t}`).trim()])) as Theme;
}

export const font = () => getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";

/** Root rules for the sandbox document: tokens, dark scheme (keeps the frame transparent), and base text. */
export function sandboxThemeCss(theme = readTheme()): string {
  const vars = THEME_TOKENS.map(t => `--${t}:${theme[t]};`).join("");
  return `:root{${vars}color-scheme:dark;}html,body{margin:0;background:transparent;}body{color:var(--foreground);font:15px/1.5 ${font()};}`;
}
