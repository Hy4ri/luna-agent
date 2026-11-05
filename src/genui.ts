import { defineExtension, section } from "@earendil-works/pi-durable";

const PROMPT = [
  "The Web UI renders these fences as visuals. Write one sentence of normal text before each block. Use only real data.",
  "Charts and plots: a `ui` fence with one JSON object.",
  "Chart: {\"type\":\"chart\",\"kind\":\"line\"|\"area\"|\"bar\"|\"pie\"|\"donut\",\"title\",\"x\":[labels],\"series\":[{\"name\",\"data\":[numbers]}],\"yUnit\",\"stacked\":true|false}. stacked applies to bar and area. pie and donut take one series and at most 12 slices.",
  "Plot: {\"type\":\"plot\",\"title\",\"expr\":\"a*x^2+b\",\"x\":[min,max],\"params\":{\"a\":{\"min\",\"max\",\"step\",\"value\"}}}. Expressions use x, the params, + - * / ^, pi, e, sin cos tan sqrt abs log exp min max.",
  "Diagrams: a `mermaid` fence (flowchart, sequence, state, class, ER, gantt, mindmap, timeline, pie, gitGraph). Formulas: a `math` fence with LaTeX.",
  "Custom visuals: an `html` fence. Static HTML/CSS/SVG without script renders inline in the chat and inherits the theme: use var(--foreground), var(--muted-foreground), var(--card), var(--secondary), var(--border), var(--primary), var(--chart-1) to var(--chart-6); keep backgrounds transparent or var(--card). Use <details> for expandable parts.",
  "HTML with script or event handlers runs in an isolated, auto-sized sandbox with the same theme variables: no parent DOM, Luna data, storage, network, external resources, forms, or popups. Use inline SVG or data images.",
  "Any element with data-luna-prompt=\"text\" (or luna.prompt(text) in script) puts that text in the user's composer on click; the user still sends it.",
  "Limits: 8 series, 500 points, 6 params, 4 ui/html blocks per message. Blocks render after the fence closes. Use a `text` fence to show source without rendering. Use a markdown table for plain lists or tables.",
].join(" ");

export const GenUiExtension = defineExtension({
  name: "genui",
  sections: [section("genui", () => PROMPT)],
});
