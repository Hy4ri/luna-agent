// Exercises IncrementalMarkdown streaming DOM reconciliation in happy-dom.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect } from "bun:test";
import { IncrementalMarkdown } from "../../../web/src/lib/markdown.ts";

GlobalRegistrator.register({ url: "http://luna.test/" });

const root = document.createElement("div");
document.body.append(root);

const md = new IncrementalMarkdown(root);

// 1. Streaming paragraph keeps the same <p> DOM node and wraps new slices in .stream-chunk
md.update("Hello ", true);
const firstP = root.querySelector("p");
expect(firstP).not.toBeNull();
md.update("Hello world", true);
expect(root.querySelector("p")).toBe(firstP);
expect(root.textContent).toBe("Hello world");
expect(root.querySelectorAll(".stream-chunk").length).toBeGreaterThanOrEqual(1);

// 2. Completing inline bold preserves the leading text node and formats <strong>
md.update("Hello **bold", true);
md.update("Hello **bold**", true);
expect(root.querySelector("p")).toBe(firstP);
const strong = root.querySelector("strong");
expect(strong?.textContent).toBe("bold");

// 3. Arabic cursive words are not split across multiple .stream-chunk spans mid-word
const arRoot = document.createElement("div");
const arMd = new IncrementalMarkdown(arRoot);
arMd.update("مرحبا ", true);
arMd.update("مرحبا ب", true);
arMd.update("مرحبا با", true);
arMd.update("مرحبا بالعالم", true);
const arChunks = Array.from(arRoot.querySelectorAll(".stream-chunk"));
expect(arChunks[arChunks.length - 1]?.textContent?.trim()).toBe("بالعالم");
arMd.dispose();

// 4. Streaming fenced code block preserves .codewrap identity and updates copy text
const codeRoot = document.createElement("div");
const codeMd = new IncrementalMarkdown(codeRoot);
codeMd.update("```ts\nconst a = 1;", true);
const wrap = codeRoot.querySelector(".codewrap");
expect(wrap).not.toBeNull();
codeMd.update("```ts\nconst a = 1;\nconst b = 2;\n```", true);
expect(codeRoot.querySelector(".codewrap")).toBe(wrap);
const copyBtn = wrap!.querySelector("button.code-copy-btn") as HTMLButtonElement & { __copyCode?: string };
expect(copyBtn.__copyCode).toBe("const a = 1;\nconst b = 2;");
codeMd.dispose();

// 5. Math node identity stays intact when text streams after it
const mathRoot = document.createElement("div");
const mathMd = new IncrementalMarkdown(mathRoot);
mathMd.update("Formula $x^2$ ", true);
const mathSpan = mathRoot.querySelector(".md-math");
expect(mathSpan).not.toBeNull();
const katexChild = document.createElement("span");
katexChild.className = "katex-mock";
mathSpan!.replaceChildren(katexChild);
mathMd.update("Formula $x^2$ continues", true);
expect(mathRoot.querySelector(".md-math")).toBe(mathSpan);
expect(mathSpan!.querySelector(".katex-mock")).toBe(katexChild);
mathMd.dispose();

// 6. Settling with streaming=false unwraps .stream-chunk and .stream-fade classes
md.update("Hello **bold**!", false);
expect(root.querySelectorAll(".stream-chunk").length).toBe(0);
expect(root.querySelectorAll(".stream-fade").length).toBe(0);
expect(root.textContent).toBe("Hello bold!");

md.dispose();
await GlobalRegistrator.unregister();
