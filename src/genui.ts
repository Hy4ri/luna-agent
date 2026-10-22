import { defineExtension, section } from "@earendil-works/pi-durable";

const PROMPT = [
  "When a chart or a live plot helps the user, write one fenced block with the language `ui`. Put one JSON object inside it.",
  "Chart: {\"type\":\"chart\",\"kind\":\"line\"|\"bar\",\"title\",\"x\":[labels],\"series\":[{\"name\",\"data\":[numbers]}],\"yUnit\"}.",
  "Plot: {\"type\":\"plot\",\"title\",\"expr\":\"a*x^2+b\",\"x\":[min,max],\"params\":{\"a\":{\"min\",\"max\",\"step\",\"value\"}}}.",
  "Expressions use x, the params, + - * / ^, pi, e, and the functions sin cos tan sqrt abs log exp min max.",
  "For a custom interactive visual, use a fenced `html` block with self-contained HTML, inline CSS, and inline JavaScript.",
  "HTML runs in an isolated sandbox: no parent DOM, Luna data, storage, API calls, external resources, forms, popups, or top navigation. Use inline SVG or data images.",
  "Use `ui` for supported charts and plots. HTML fences render as previews, not plain code; use a `text` fence when showing HTML source only.",
  "Limits: 8 series, 500 points, 6 params, 4 total ui/html previews per message. HTML executes only after its fence closes.",
  "Use only real data. Do not use a widget for a plain list or table: use a markdown table.",
  "Always write one sentence of normal text before the block.",
].join(" ");

export const GenUiExtension = defineExtension({
  name: "genui",
  sections: [section("genui", () => PROMPT)],
});
