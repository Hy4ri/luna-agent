// DOM primitives shared by every module. No imports, no side effects.
export const $ = (id) => document.getElementById(id);
export const h = (tag, props = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === "class") e.className = v; else if (k.startsWith("on")) e[k] = v; else if (v !== undefined && v !== null) e.setAttribute(k, v); } if ((tag === "input" || tag === "textarea") && props.placeholder && !props["aria-label"]) e.setAttribute("aria-label", props.placeholder); e.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false)); return e; };
export const MOBILE = "(max-width: 760px)";

const PATHS = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  moon: '<path d="M20.5 13A9 9 0 0 1 11 3.5 9 9 0 1 0 20.5 13Z"/>',
};
// Returns a fresh inline SVG icon element. Unknown names return an empty icon.
export function icon(name) {
  const t = document.createElement("template");
  t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ""}</svg>`;
  return t.content.firstChild;
}
