// Markdown builds DOM nodes; only KaTeX may generate inert math markup. Links are limited to http(s)/mailto.
import { h } from "./dom";
import { copyToClipboard } from "./message";
import { openFence, closesFence, fenceLang, findFenceEnd } from "./fences";

// Loaded only when a message contains math, sharing the existing GenUI KaTeX chunk.
let mathEngine: Promise<typeof import("katex")> | undefined;
function mathNode(source: string, displayMode: boolean, literal: string): HTMLElement {
  const node = h("span", { class: displayMode ? "md-math md-math-display" : "md-math", dir: "ltr", "data-math-key": (displayMode ? "d:" : "i:") + source }, literal);
  mathEngine ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")])
    .then(([engine]) => engine).catch(error => { mathEngine = undefined; throw error; });
  void mathEngine.then(({ default: katex }) => {
    katex.render(source, node, { displayMode, throwOnError: true, trust: false, strict: "ignore", maxSize: 20, maxExpand: 1000, output: "htmlAndMathml" });
  }).catch(() => { node.textContent = literal; });
  return node;
}

function inline(text: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  // Tokenizer pattern:
  // 1: inline code: `code`
  // 3,4,5: image: ![alt](url "title")
  // 6,7,8: link: [text](url "title")
  // 9: autolink: <url>
  // 10: raw url: https://...
  // 11: bold+italic: ***text***
  // 12: bold: **text**
  // 13: italic: *text*
  // 14: underscore bold: __text__
  // 15: underscore italic: \b_text_\b
  // 16: strikethrough: ~~text~~
  // 17: keyboard key: <kbd>text</kbd> (plain text, no attributes)
  // 18..21: display/inline math ($$, \[...\], \(...\), $)
  // \n: line break
  const re = /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)|<((?:https?|mailto):[^\s>]+)>|\b(https?:\/\/[^\s<)]+)|\*\*\*([^*\s\n](?:[^*\n]*?[^*\s\n])?)\*\*\*|\*\*([^*\s\n](?:[^*\n]*?[^*\s\n])?)\*\*|\*([^*\s\n](?:[^*\n]*?[^*\s\n])?)\*|__([^_\s\n](?:[^_\n]*?[^_\s\n])?)__|\b_([^_\s\n](?:[^_\n]*?[^_\s\n])?)_\b|~~([^~\s\n](?:[^~\n]*?[^~\s\n])?)~~|<kbd>([^<>\n]*)<\/kbd>|(?<!\\)\$\$([\s\S]+?)\$\$|(?<!\\)\\\[([\s\S]+?)\\\]|(?<!\\)\\\(([^\n]+?)\\\)|(?<![\\$])\$(?![\s$])((?:\\[^\n]|[^$\n\\])+?)(?<!\s)\$(?![\d$])|\n/g;

  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      out.push(document.createTextNode(text.slice(last, m.index)));
    }
    if (m[1]) {
      // Inline code
      out.push(h("code", { dir: "ltr" }, m[2]));
    } else if (m[4]) {
      // Image: ![alt](url "title")
      out.push(safeImage(m[4], m[3] || "", m[5]));
    } else if (m[6]) {
      // Link: [text](url "title")
      out.push(safeLink(m[7], inline(m[6]), m[8]));
    } else if (m[9]) {
      // Autolink: <url>
      out.push(safeLink(m[9], [m[9]]));
    } else if (m[10]) {
      // Raw URL
      out.push(safeLink(m[10], [m[10]]));
    } else if (m[11]) {
      // Bold + Italic
      out.push(h("strong", {}, h("em", {}, ...inline(m[11]))));
    } else if (m[12] || m[14]) {
      // Bold
      out.push(h("strong", {}, ...inline(m[12] || m[14])));
    } else if (m[13] || m[15]) {
      // Italic
      out.push(h("em", {}, ...inline(m[13] || m[15])));
    } else if (m[16]) {
      // Strikethrough
      out.push(h("del", {}, ...inline(m[16])));
    } else if (m[17] !== undefined) {
      // Only this exact tag pair is supported; content stays text, never HTML.
      out.push(h("kbd", { dir: "auto" }, m[17]));
    } else if (m[18] !== undefined || m[19] !== undefined || m[20] !== undefined || m[21] !== undefined) {
      out.push(mathNode(m[18] ?? m[19] ?? m[20] ?? m[21], m[18] !== undefined || m[19] !== undefined, m[0]));
    } else if (m[0] === "\n") {
      out.push(h("br"));
    }
    last = re.lastIndex;
  }
  if (last < text.length) {
    out.push(document.createTextNode(text.slice(last)));
  }
  return out;
}

function safeLink(href: string, kids: (Node | string)[], title?: string) {
  const clean = href.trim();
  if (!/^(https?:|mailto:)/i.test(clean)) return h("span", {}, ...kids);
  const props: Record<string, unknown> = { href: clean, target: "_blank", rel: "noopener noreferrer", dir: "auto" };
  if (title) props.title = title;
  return h("a", props, ...kids);
}

function safeImage(src: string, alt: string, title?: string) {
  const clean = src.trim();
  if (!/^(https?:|data:image\/)/i.test(clean)) return h("span", { class: "md-bad-img" }, `[image: ${alt || "untrusted"}]`);
  const props: Record<string, unknown> = { src: clean, alt: alt || "image", class: "md-img", loading: "lazy" };
  if (title) props.title = title;
  return h("img", props);
}

type CopyButton = HTMLButtonElement & { __copyCode?: string };

function codeBlock(code: string, lang = ""): HTMLElement {
  const cleanLang = (lang || "").trim().toLowerCase();
  const wrap = h("div", { dir: "ltr", class: "codewrap", ...(cleanLang ? { "data-lang": cleanLang } : {}) });
  const header = h("div", { class: "code-header" });
  const langLabel = h("span", { class: "code-lang" }, cleanLang || "text");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const btn = h("button", {
    type: "button",
    class: "code-copy-btn",
    "aria-label": "Copy code",
    "aria-live": "polite",
    onclick: async () => {
      if (btn.disabled) return;
      clearTimeout(timer);
      btn.disabled = true;
      const ok = await copyToClipboard(btn.__copyCode ?? code);
      btn.disabled = false;
      btn.textContent = ok ? "copied" : "copy failed";
      timer = setTimeout(() => { btn.textContent = "copy"; }, 2000);
    },
  }, "copy") as CopyButton;
  btn.__copyCode = code;
  header.append(langLabel, btn);

  const codeEl = h("code", { dir: "ltr" }, code);
  const pre = h("pre", { class: "code" }, codeEl);
  wrap.append(header, pre);
  return wrap;
}

function splitCells(s: string): string[] {
  const trimmed = s.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const clean = inner.endsWith("|") && !inner.endsWith("\\|") ? inner.slice(0, -1) : inner;
  return clean.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function parseAlignments(sepLine: string): ("start" | "left" | "center" | "right")[] {
  const cells = splitCells(sepLine);
  return cells.map((cell) => {
    const t = cell.trim();
    const l = t.startsWith(":");
    const r = t.endsWith(":");
    if (l && r) return "center";
    if (r) return "right";
    return l ? "left" : "start";
  });
}

const SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/;

function markdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  let i = 0, para: string[] = [];

  const flush = () => {
    if (para.length) {
      frag.append(h("p", { dir: "auto" }, ...inline(para.map(p => p.trimEnd()).join("\n"))));
      para = [];
    }
  };

  while (i < lines.length) {
    const l = lines[i];
    let m: RegExpExecArray | null;

    // Fenced code block: length-aware open/close rules shared with segments.ts
    const fence = openFence(l);
    if (fence) {
      flush();
      const end = findFenceEnd(lines, i + 1, fence);
      const stop = end === -1 ? lines.length : end;
      frag.append(codeBlock(lines.slice(i + 1, stop).join("\n"), fenceLang(fence)));
      i = end === -1 ? lines.length : end + 1;
      continue;
    }

    // Display formulas are atomic: their newlines are not Markdown structure.
    const display = /^\s*(\$\$|\\\[)/.exec(l);
    if (display) {
      const delimiter = display[1] === "$$" ? "$$" : "\\]";
      const start = l.indexOf(display[1]) + display[1].length;
      let end = i;
      while (end < lines.length && lines[end].indexOf(delimiter, end === i ? start : 0) === -1) end++;
      if (end < lines.length) {
        flush();
        frag.append(...inline(lines.slice(i, end + 1).join("\n")));
        i = end + 1;
        continue;
      }
    }

    // Headings h1..h6
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) {
      flush();
      const level = Math.min(Math.max(m[1].length, 1), 6);
      frag.append(h("h" + level, { dir: "auto" }, ...inline(m[2])));
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(l)) {
      flush();
      frag.append(h("hr"));
      i++;
      continue;
    }

    // Blockquote
    if (/^\s*>/.test(l)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && (/^\s*>/.test(lines[i]) || (q.length > 0 && lines[i].trim() !== "" && !/^\s*(?:`{3,}|~{3,}|#{1,6}|[-*+]|\d+[.)]|\|)/.test(lines[i])))) {
        if (/^\s*>/.test(lines[i])) {
          q.push(lines[i++].replace(/^\s*>\s?/, ""));
        } else {
          q.push(lines[i++]);
        }
      }
      const bq = h("blockquote", { dir: "auto" });
      bq.append(markdown(q.join("\n")));
      frag.append(bq);
      continue;
    }

    // Table
    if (l.includes("|") && i + 1 < lines.length && SEP_RE.test(lines[i + 1])) {
      flush();
      const headers = splitCells(l);
      const aligns = parseAlignments(lines[i + 1]);
      const table = h("table");
      const thead = h("thead");
      const headTr = h("tr");
      headers.forEach((hText, idx) => {
        const align = aligns[idx] || "start";
        const th = h("th", { dir: "auto", style: `text-align: ${align};` }, ...inline(hText));
        headTr.append(th);
      });
      thead.append(headTr);
      table.append(thead);

      i += 2; // skip header and separator
      const tbody = h("tbody");
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        const rowCells = splitCells(lines[i++]);
        const tr = h("tr");
        for (let c = 0; c < headers.length; c++) {
          const align = aligns[c] || "start";
          const cellText = rowCells[c] !== undefined ? rowCells[c] : "";
          const td = h("td", { dir: "auto", style: `text-align: ${align};` }, ...inline(cellText));
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      const wrap = h("div", { class: "table-wrap" }, table);
      frag.append(wrap);
      continue;
    }

    // Lists (unordered, ordered, task list)
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      flush();
      const listMatch = /^\s*(\d+)[.)]\s+/.exec(l);
      const isOrdered = Boolean(listMatch);
      const startNum = listMatch ? parseInt(listMatch[1], 10) : 1;
      const listProps: Record<string, unknown> = { dir: "auto" };
      if (isOrdered && startNum !== 1) listProps.start = startNum;
      const list = h(isOrdered ? "ol" : "ul", listProps);

      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const itemLine = lines[i++];
        const itemText = itemLine.replace(/^\s*([-*+]|\d+[.)])\s+/, "");
        const subLines: string[] = [];

        while (i < lines.length && (/^\s{2,}\S/.test(lines[i]) || lines[i].trim() === "")) {
          if (lines[i].trim() === "") {
            if (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) {
              i++;
              continue;
            } else {
              break;
            }
          }
          subLines.push(lines[i++]);
        }

        const li = h("li", { dir: "auto" });
        const taskMatch = /^\[([ xX])\](?:\s+(.*))?$/.exec(itemText);
        if (taskMatch) {
          li.className = "task-list-item";
          const checked = taskMatch[1].toLowerCase() === "x";
          const chk = h("input", {
            type: "checkbox",
            disabled: "true",
            class: "task-checkbox",
            ...(checked ? { checked: "true" } : {}),
          });
          li.append(chk, " ", ...inline(taskMatch[2] || ""));
        } else {
          li.append(...inline(itemText));
        }

        if (subLines.length > 0) {
          const unindented = subLines.map(s => s.replace(/^\s{2,4}/, ""));
          li.append(markdown(unindented.join("\n")));
        }

        list.append(li);
      }
      frag.append(list);
      continue;
    }

    // Blank line
    if (!l.trim()) {
      flush();
      i++;
      continue;
    }

    para.push(l);
    i++;
  }

  flush();
  return frag;
}

// Splits source into blocks at blank lines outside code fences. Rendering the blocks
// one by one gives the same DOM as rendering the whole source, because blank lines
// end every top-level construct. An indented line after a blank line can continue a
// list item, so such a block stays attached to the previous one.
function splitBlocks(src: string): string[] {
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  const blocks: string[][] = [];
  let cur: string[] = [];
  let fence: ReturnType<typeof openFence> = null;
  let blankRun = false;
  let mathClose: string | null = null;
  for (const l of lines) {
    if (fence) {
      if (closesFence(l, fence)) fence = null;
    } else if (mathClose) {
      if (l.includes(mathClose)) mathClose = null;
    } else {
      fence = openFence(l);
      const display = !fence && /^\s*(\$\$|\\\[)/.exec(l);
      if (display) {
        const close = display[1] === "$$" ? "$$" : "\\]";
        if (!l.slice(l.indexOf(display[1]) + display[1].length).includes(close)) mathClose = close;
      }
    }
    const blank = !fence && !mathClose && !l.trim();
    if (blankRun && !blank && cur.length && !/^\s{2,}\S/.test(l)) {
      blocks.push(cur);
      cur = [];
    }
    blankRun = blank;
    cur.push(l);
  }
  if (cur.length) blocks.push(cur);
  return blocks.map((b) => b.join("\n"));
}

const CHUNK_CLASS = "stream-chunk";
const FADE_CLASS = "stream-fade";
const CHUNK_SETTLE_MS = 220;
const MAX_ACTIVE_CHUNKS = 12;

function isConnectedScriptCode(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) || // Combining Diacritical Marks
    (code >= 0x0600 && code <= 0x06ff) || // Arabic
    (code >= 0x0700 && code <= 0x077f) || // Syriac + Arabic Supplement
    (code >= 0x08a0 && code <= 0x08ff) || // Arabic Extended-A
    (code >= 0x0900 && code <= 0x0dff) || // Indic scripts
    (code >= 0xfb50 && code <= 0xfdff) || // Arabic Presentation Forms-A
    (code >= 0xfe70 && code <= 0xfeff) || // Arabic Presentation Forms-B
    code === 0x200c || code === 0x200d   // ZWNJ / ZWJ
  );
}

function isConnectedBoundary(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ca = a.charCodeAt(a.length - 1);
  const cb = b.charCodeAt(0);
  if (ca <= 0x20 || cb <= 0x20) return false;
  return isConnectedScriptCode(ca) || isConnectedScriptCode(cb);
}

function isStreamChunk(node: Node | undefined): node is HTMLSpanElement {
  return !!node && node.nodeType === 1 && (node as Element).classList.contains(CHUNK_CLASS);
}

function isTextLike(node: Node | undefined): boolean {
  return !!node && (node.nodeType === 3 || isStreamChunk(node));
}

function makeChunkNode(text: string, now: number): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = CHUNK_CLASS;
  span.setAttribute("data-t", String(now));
  span.textContent = text;
  return span;
}

function unwrapChunk(span: HTMLSpanElement, prevNode: Node | undefined): Node | null {
  const parent = span.parentNode;
  if (!parent) return null;
  const text = span.textContent ?? "";
  if (prevNode && prevNode.nodeType === 3) {
    prevNode.nodeValue = (prevNode.nodeValue ?? "") + text;
    parent.removeChild(span);
    return null;
  }
  const txt = document.createTextNode(text);
  parent.replaceChild(txt, span);
  return txt;
}

function settleRun(nodes: Node[], forceAll: boolean, now: number): Node[] {
  let totalChunks = 0;
  for (const n of nodes) if (isStreamChunk(n)) totalChunks++;
  if (totalChunks === 0) return nodes;

  const kept: Node[] = [];
  let seenChunks = 0;
  for (const n of nodes) {
    if (!isStreamChunk(n)) {
      kept.push(n);
      continue;
    }
    const createdAt = Number(n.getAttribute("data-t") || 0);
    const remainingFromEnd = totalChunks - seenChunks;
    seenChunks++;
    if (forceAll || remainingFromEnd > MAX_ACTIVE_CHUNKS || now - createdAt >= CHUNK_SETTLE_MS) {
      const replacement = unwrapChunk(n, kept[kept.length - 1]);
      if (replacement) kept.push(replacement);
    } else {
      kept.push(n);
    }
  }
  return kept;
}

function normalizedClass(el: Element): string {
  const raw = el.getAttribute("class");
  if (!raw) return "";
  return raw.split(/\s+/).filter(c => c && c !== FADE_CLASS).join(" ");
}

function sameElementShape(a: Element, b: Element): boolean {
  if (a.tagName !== b.tagName) return false;
  if (isStreamChunk(a) || isStreamChunk(b)) return false;
  if (normalizedClass(a) !== normalizedClass(b)) return false;
  const aAttrs = a.attributes;
  const bAttrs = b.attributes;
  let aCount = 0;
  for (let i = 0; i < aAttrs.length; i++) {
    const name = aAttrs[i].name;
    if (name === "class") continue;
    aCount++;
    if (b.getAttribute(name) !== aAttrs[i].value) return false;
  }
  let bCount = 0;
  for (let i = 0; i < bAttrs.length; i++) {
    if (bAttrs[i].name !== "class") bCount++;
  }
  return aCount === bCount;
}

function snapTextSplit(text: string, end: number): number {
  let i = Math.max(0, Math.min(end, text.length));
  if (i > 0 && i < text.length) {
    const prev = text.charCodeAt(i - 1);
    const next = text.charCodeAt(i);
    if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) i--;
  }
  while (i > 0 && isConnectedScriptCode(text.charCodeAt(i))) i--;
  return i;
}

function appendStreamingText(
  parent: Node,
  anchor: Node | null,
  kept: Node[],
  prevText: string,
  added: string,
  streaming: boolean,
  now: number,
): void {
  if (!added) return;
  const last = kept[kept.length - 1];
  if (streaming) {
    if (last && isConnectedBoundary(prevText, added)) {
      if (isStreamChunk(last)) {
        last.textContent = (last.textContent ?? "") + added;
        return;
      }
      if (last.nodeType === 3) {
        last.nodeValue = (last.nodeValue ?? "") + added;
        return;
      }
    }
    const chunk = makeChunkNode(added, now);
    parent.insertBefore(chunk, anchor);
    kept.push(chunk);
    return;
  }
  if (last && last.nodeType === 3) {
    last.nodeValue = (last.nodeValue ?? "") + added;
    return;
  }
  const txt = document.createTextNode(added);
  parent.insertBefore(txt, anchor);
  kept.push(txt);
}

function reconcileTextRun(
  parent: Node,
  anchor: Node | null,
  oldRun: Node[],
  newText: string,
  streaming: boolean,
  now: number,
): Node[] {
  const oldText = oldRun.map(n => n.textContent ?? "").join("");
  if (oldText === newText) {
    return settleRun(oldRun, !streaming, now);
  }
  if (newText.startsWith(oldText)) {
    const kept = settleRun(oldRun, !streaming, now);
    appendStreamingText(parent, anchor, kept, oldText, newText.slice(oldText.length), streaming, now);
    return kept;
  }
  let common = 0;
  const limit = Math.min(oldText.length, newText.length);
  while (common < limit && oldText.charCodeAt(common) === newText.charCodeAt(common)) common++;
  common = snapTextSplit(newText, common);

  const kept: Node[] = [];
  let pos = 0;
  for (const n of oldRun) {
    const text = n.textContent ?? "";
    const end = pos + text.length;
    if (end <= common) {
      kept.push(n);
    } else if (pos < common) {
      const keepLen = common - pos;
      if (n.nodeType === 3) {
        n.nodeValue = text.slice(0, keepLen);
      } else {
        n.textContent = text.slice(0, keepLen);
      }
      kept.push(n);
    } else {
      parent.removeChild(n);
    }
    pos = end;
  }

  const settled = settleRun(kept, !streaming, now);
  appendStreamingText(parent, anchor, settled, newText.slice(0, common), newText.slice(common), streaming, now);
  return settled;
}

function reconcileSequence(
  parent: Node,
  anchor: Node | null,
  oldNodes: Node[],
  newNodes: Node[],
  streaming: boolean,
  now: number,
): Node[] {
  const result: Node[] = [];
  let oi = 0, ni = 0;

  while (oi < oldNodes.length && ni < newNodes.length) {
    const oldN = oldNodes[oi];
    const newN = newNodes[ni];
    if (isTextLike(oldN) && newN.nodeType === 3) {
      const oldRun: Node[] = [];
      while (oi < oldNodes.length && isTextLike(oldNodes[oi])) oldRun.push(oldNodes[oi++]);
      let newText = newN.textContent ?? "";
      ni++;
      while (ni < newNodes.length && newNodes[ni].nodeType === 3) {
        newText += newNodes[ni++].textContent ?? "";
      }
      const runAnchor = oi < oldNodes.length ? oldNodes[oi] : anchor;
      result.push(...reconcileTextRun(parent, runAnchor, oldRun, newText, streaming, now));
      continue;
    }
    if (oldN.nodeType === 1 && newN.nodeType === 1 && sameElementShape(oldN as Element, newN as Element)) {
      const oldEl = oldN as Element;
      const newEl = newN as Element;
      if ("__copyCode" in newEl) {
        (oldEl as CopyButton).__copyCode = (newEl as CopyButton).__copyCode;
      }
      if (!oldEl.classList.contains("md-math")) {
        reconcileSequence(oldEl, null, Array.from(oldEl.childNodes), Array.from(newEl.childNodes), streaming, now);
      }
      result.push(oldEl);
      oi++;
      ni++;
      continue;
    }
    break;
  }

  while (oi < oldNodes.length) {
    parent.removeChild(oldNodes[oi++]);
  }
  while (ni < newNodes.length) {
    const newN = newNodes[ni++];
    let inserted: Node;
    if (streaming && newN.nodeType === 3) {
      inserted = makeChunkNode(newN.textContent ?? "", now);
    } else {
      if (streaming && newN.nodeType === 1) (newN as Element).classList.add(FADE_CLASS);
      inserted = newN;
    }
    parent.insertBefore(inserted, anchor);
    result.push(inserted);
  }
  return result;
}

function clearStreamClasses(root: ParentNode): void {
  if ("querySelectorAll" in root) {
    for (const span of Array.from(root.querySelectorAll<HTMLSpanElement>(`span.${CHUNK_CLASS}`))) {
      const prev = span.previousSibling ?? undefined;
      unwrapChunk(span, prev);
    }
    for (const el of Array.from(root.querySelectorAll<Element>(`.${FADE_CLASS}`))) {
      el.classList.remove(FADE_CLASS);
    }
  }
}

// Keeps the DOM of finished blocks and reconciles changed blocks in-place so streaming text flows smoothly.
export class IncrementalMarkdown {
  private blocks: { src: string; nodes: Node[] }[] = [];
  private settleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private container: HTMLElement) {}

  update(src: string, streaming = false) {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const next = splitBlocks(src);
    let k = 0;
    while (k < next.length && k < this.blocks.length && next[k] === this.blocks[k].src) k++;

    if (!streaming) {
      this.clearSettleTimer();
      clearStreamClasses(this.container);
    }

    if (k < this.blocks.length && k < next.length) {
      for (const b of this.blocks.splice(k + 1)) {
        for (const n of b.nodes) this.container.removeChild(n);
      }
      const frag = markdown(next[k]);
      const reconciled = reconcileSequence(
        this.container,
        null,
        this.blocks[k].nodes,
        Array.from(frag.childNodes),
        streaming,
        now,
      );
      this.blocks[k] = { src: next[k], nodes: reconciled };
      k++;
    } else {
      for (const b of this.blocks.splice(k)) {
        for (const n of b.nodes) this.container.removeChild(n);
      }
    }

    for (; k < next.length; k++) {
      const frag = markdown(next[k]);
      const nodes = Array.from(frag.childNodes);
      if (streaming) {
        for (const n of nodes) {
          if (n.nodeType === 1) (n as Element).classList.add(FADE_CLASS);
        }
      }
      this.blocks.push({ src: next[k], nodes });
      this.container.append(frag);
    }

    if (streaming) {
      this.scheduleSettle();
    }
  }

  dispose() {
    this.clearSettleTimer();
  }

  private clearSettleTimer() {
    if (this.settleTimer !== undefined) {
      clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    }
  }

  private scheduleSettle() {
    this.clearSettleTimer();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      let hasActive = false;
      for (const span of Array.from(this.container.querySelectorAll<HTMLSpanElement>(`span.${CHUNK_CLASS}`))) {
        const createdAt = Number(span.getAttribute("data-t") || 0);
        if (now - createdAt >= CHUNK_SETTLE_MS) {
          unwrapChunk(span, span.previousSibling ?? undefined);
        } else {
          hasActive = true;
        }
      }
      if (hasActive) this.scheduleSettle();
    }, CHUNK_SETTLE_MS + 30);
  }
}
