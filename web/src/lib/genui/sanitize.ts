// Model output is untrusted: a prompt injection can make the model write any markup.
// Everything here renders in the app origin, so it must not run script, load remote
// resources, submit forms, or cover the app. Markup with scripts goes to the sandbox instead.
import DOMPurify from "dompurify";

let purifier: ReturnType<typeof DOMPurify> | null = null;
const purify = () => (purifier ??= DOMPurify(window));

// Local references only: same-document fragments (SVG markers, gradients) and inline images.
const SAFE_REF = /^(#|data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,])/i;
const SAFE_LINK = /^(https?:|mailto:)/i;

/**
 * Replaces every CSS url()/image-set() that points outside the document and drops @import.
 * Fixed positioning becomes relative: inline content must stay in the message flow.
 */
export function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/position\s*:\s*fixed/gi, "position:relative")
    .replace(/image-set\s*\(/gi, "none(")
    .replace(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, _q, target: string) => (SAFE_REF.test(target.trim()) ? m : "none"));
}

function cleanRefs(root: DocumentFragment | Element) {
  for (const el of root.querySelectorAll("*")) {
    for (const attr of ["src", "href", "xlink:href"]) {
      const value = el.getAttribute(attr);
      if (value === null) continue;
      if (el.localName === "a" && attr === "href" && SAFE_LINK.test(value.trim())) continue;
      if (!SAFE_REF.test(value.trim()) || (el.localName === "a" && attr === "href")) el.removeAttribute(attr);
    }
    if (el.localName === "a" && el.hasAttribute("href")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
    // An image without a usable source would only show a broken-image icon.
    if ((el.localName === "img" || el.localName === "image") && !el.hasAttribute("src") && !el.hasAttribute("href") && !el.hasAttribute("xlink:href")) {
      el.remove();
      continue;
    }
    const style = el.getAttribute("style");
    if (style !== null) el.setAttribute("style", cleanCss(style));
    if (el.localName === "style") el.textContent = cleanCss(el.textContent ?? "");
  }
}

/** Mermaid output. Labels may be HTML inside foreignObject; Mermaid's strict mode escapes them, this is defense in depth. */
export function sanitizeSvg(svg: string): DocumentFragment {
  const fragment = purify().sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ["foreignObject"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_TAGS: ["a", "script", "use", "iframe", "object", "embed", "form", "input", "textarea", "select", "button"],
    FORBID_ATTR: ["srcset", "ping"],
    RETURN_DOM_FRAGMENT: true,
  });
  cleanRefs(fragment);
  return fragment;
}

export type HtmlRoute =
  | { mode: "inline"; css: string; body: DocumentFragment }
  | { mode: "sandbox" };

// Interactive or embedding elements: either they need script, or they could fetch, submit, or phish.
const FORBID_INLINE = ["script", "iframe", "frame", "frameset", "object", "embed", "form", "input", "textarea", "select", "option", "video", "audio", "source", "track", "link", "meta", "base", "noscript", "template", "dialog", "use", "portal"];

/**
 * Decides how an html fence renders. Static markup (no script, no event handlers, no javascript: URLs)
 * renders inline after sanitizing. Anything with behavior needs the sandbox.
 */
export function routeHtml(source: string): HtmlRoute {
  const doc = new DOMParser().parseFromString(source, "text/html");
  if (doc.querySelector("script, iframe, frame, object, embed, form, input, textarea, select")) return { mode: "sandbox" };
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of el.attributes) {
      if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) return { mode: "sandbox" };
    }
  }
  // Head styles are lost when only the body is sanitized, so collect them first.
  const css = cleanCss([...doc.querySelectorAll("style")].map(s => s.textContent ?? "").join("\n"));
  for (const s of doc.querySelectorAll("style")) s.remove();
  const body = purify().sanitize(doc.body.innerHTML, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    FORBID_TAGS: FORBID_INLINE,
    FORBID_ATTR: ["srcset", "ping", "formaction", "action", "autofocus", "popover", "popovertarget"],
    RETURN_DOM_FRAGMENT: true,
  });
  cleanRefs(body);
  return { mode: "inline", css, body };
}

/** Builds the sandboxed document: theme first in head so the page's own styles still win. */
export function sandboxDocument(source: string, themeCss: string, helper: string): string {
  const doc = new DOMParser().parseFromString(source, "text/html");
  const style = doc.createElement("style");
  style.textContent = themeCss;
  const script = doc.createElement("script");
  script.textContent = helper;
  doc.head.prepend(style, script);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

// The browser serializes every parsed URL as url("..."), so this catches escaped forms
// such as \75 rl(...) that the text pass cannot see.
const CSSOM_URL = /url\("((?:[^"\\]|\\.)*)"\)/gi;
const hasRemoteUrl = (value: string) => [...value.matchAll(CSSOM_URL)].some(m => !SAFE_REF.test(m[1]!.trim())) || /image-set\(|cross-fade\(|\bimage\(/i.test(value);

function scrubDeclaration(style: CSSStyleDeclaration) {
  for (const prop of [...style]) if (hasRemoteUrl(style.getPropertyValue(prop))) style.removeProperty(prop);
}

function scrubRules(rules: CSSRuleList) {
  for (const rule of [...rules]) {
    if ("style" in rule && rule.style instanceof CSSStyleDeclaration) scrubDeclaration(rule.style);
    if ("cssRules" in rule && rule.cssRules) scrubRules(rule.cssRules as CSSRuleList);
  }
}

/** Second pass on parsed CSS in a shadow root: style elements, adopted sheets, and style attributes. Run right after insertion, before paint. */
export function scrubCssom(root: ShadowRoot) {
  for (const sheet of [...root.styleSheets, ...root.adoptedStyleSheets]) scrubRules(sheet.cssRules);
  for (const el of root.querySelectorAll<HTMLElement | SVGElement>("[style]")) scrubDeclaration(el.style);
}
