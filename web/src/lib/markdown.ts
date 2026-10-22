// Markdown builds DOM nodes only (never innerHTML). Links are limited to http(s)/mailto.
import { h } from "./dom";
import { copyToClipboard } from "./message";
import { openFence, closesFence, fenceLang, findFenceEnd } from "./fences";

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
  // \n: line break
  const re = /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)|<((?:https?|mailto):[^\s>]+)>|\b(https?:\/\/[^\s<)]+)|\*\*\*([^*\s\n](?:[^*\n]*?[^*\s\n])?)\*\*\*|\*\*([^*\s\n](?:[^*\n]*?[^*\s\n])?)\*\*|\*([^*\s\n](?:[^*\n]*?[^*\s\n])?)\*|__([^_\s\n](?:[^_\n]*?[^_\s\n])?)__|\b_([^_\s\n](?:[^_\n]*?[^_\s\n])?)_\b|~~([^~\s\n](?:[^~\n]*?[^~\s\n])?)~~|\n/g;

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
      const ok = await copyToClipboard(code);
      btn.disabled = false;
      btn.textContent = ok ? "copied" : "copy failed";
      timer = setTimeout(() => { btn.textContent = "copy"; }, 2000);
    },
  }, "copy") as HTMLButtonElement;
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

export function markdown(src: string): DocumentFragment {
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
export function splitBlocks(src: string): string[] {
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  const blocks: string[][] = [];
  let cur: string[] = [];
  let fence: ReturnType<typeof openFence> = null;
  let blankRun = false;
  for (const l of lines) {
    if (fence) {
      if (closesFence(l, fence)) fence = null;
    } else {
      fence = openFence(l);
    }
    const blank = !fence && !l.trim();
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

// Keeps the DOM of finished blocks and re-renders only the first changed block and the ones after it.
export class IncrementalMarkdown {
  private blocks: { src: string; nodes: Node[] }[] = [];
  constructor(private container: HTMLElement) {}

  update(src: string) {
    const next = splitBlocks(src);
    let k = 0;
    while (k < next.length && k < this.blocks.length && next[k] === this.blocks[k].src) k++;
    for (const b of this.blocks.splice(k)) for (const n of b.nodes) this.container.removeChild(n);
    for (; k < next.length; k++) {
      const frag = markdown(next[k]);
      this.blocks.push({ src: next[k], nodes: Array.from(frag.childNodes) });
      this.container.append(frag);
    }
  }
}
