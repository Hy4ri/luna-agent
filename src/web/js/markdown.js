// Moved verbatim from the original inline app script; see CONTRACT.md module map.
import { $, h } from "./dom.js";

// ---- markdown: builds DOM nodes only (never innerHTML), links limited to http(s)/mailto ----
function inline(text) {
  const out = [];
  const re = /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<)]+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) out.push(h("code", {}, m[2]));
    else if (m[3] || m[4]) out.push(h("strong", {}, ...inline(m[3] || m[4])));
    else if (m[5] || m[6]) out.push(h("em", {}, ...inline(m[5] || m[6])));
    else if (m[7]) out.push(h("del", {}, ...inline(m[7])));
    else if (m[8]) out.push(safeLink(m[9], inline(m[8])));
    else if (m[10]) out.push(safeLink(m[10], [m[10]]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}
function safeLink(href, kids) {
  if (!/^(https?:|mailto:)/i.test(href)) return h("span", {}, ...kids);
  return h("a", { href, target: "_blank", rel: "noopener noreferrer" }, ...kids);
}
function codeBlock(code) {
  const pre = h("pre", { class: "code" }, code);
  const btn = h("button", { type: "button", onclick: () => { navigator.clipboard?.writeText(code); btn.textContent = "copied"; setTimeout(() => (btn.textContent = "copy"), 1200); } }, "copy");
  return h("div", { class: "codewrap" }, pre, btn);
}
export function markdown(src) {
  const frag = document.createDocumentFragment();
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  let i = 0, para = [];
  const flush = () => { if (para.length) { frag.append(h("p", {}, ...inline(para.join("\n")))); para = []; } };
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if ((m = /^\s*(```|~~~)/.exec(l))) {
      flush();
      const fence = m[1], body = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence)) body.push(lines[i++]);
      i++; frag.append(codeBlock(body.join("\n"))); continue;
    }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { flush(); frag.append(h("h" + Math.min(m[1].length, 4), {}, ...inline(m[2]))); i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { flush(); frag.append(h("hr")); i++; continue; }
    if (/^\s*>/.test(l)) {
      flush(); const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      const bq = h("blockquote"); bq.append(markdown(q.join("\n"))); frag.append(bq); continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      flush();
      const ordered = /^\s*\d/.test(l), list = h(ordered ? "ol" : "ul");
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const item = [lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, "")];
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) item.push(lines[i++].trim());
        const li = h("li"); li.append(...inline(item.join("\n"))); list.append(li);
      }
      frag.append(list); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const cells = (s) => s.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const table = h("table"), head = h("tr");
      for (const c of cells(l)) head.append(h("th", {}, ...inline(c)));
      table.append(head); i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { const tr = h("tr"); for (const c of cells(lines[i++])) tr.append(h("td", {}, ...inline(c))); table.append(tr); }
      frag.append(table); continue;
    }
    if (!l.trim()) { flush(); i++; continue; }
    para.push(l); i++;
  }
  flush();
  return frag;
}
