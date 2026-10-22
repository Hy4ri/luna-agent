import { defineExtension, section } from "@earendil-works/pi-durable";

const PROMPT = [
  "When a chart or a live plot helps the user, write one fenced block with the language `ui`. Put one JSON object inside it.",
  "Chart: {\"type\":\"chart\",\"kind\":\"line\"|\"bar\",\"title\",\"x\":[labels],\"series\":[{\"name\",\"data\":[numbers]}],\"yUnit\"}.",
  "Plot: {\"type\":\"plot\",\"title\",\"expr\":\"a*x^2+b\",\"x\":[min,max],\"params\":{\"a\":{\"min\",\"max\",\"step\",\"value\"}}}.",
  "Expressions use x, the params, + - * / ^, pi, e, and the functions sin cos tan sqrt abs log exp min max.",
  "Limits: 8 series, 500 points, 6 params, 4 widgets per message.",
  "Use only real data. Do not use a widget for a plain list or table: use a markdown table.",
  "Always write one sentence of normal text before the block.",
].join(" ");

export const GenUiExtension = defineExtension({
  name: "genui",
  sections: [section("genui", () => PROMPT)],
});
