import { ref, type Ref } from "vue";

export const MOBILE = "(max-width: 760px)";
const mobile = ref(typeof matchMedia === "function" && matchMedia(MOBILE).matches);
if (typeof matchMedia === "function") matchMedia(MOBILE).addEventListener("change", e => { mobile.value = e.matches; });
export function useMobile(): Ref<boolean> { return mobile; }
export const isMobile = () => matchMedia(MOBILE).matches;

type Kid = Node | string | null | undefined | false | Kid[];
// Small DOM builder for markdown output. Never sets innerHTML.
export function h(tag: string, props: Record<string, unknown> = {}, ...kids: Kid[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = String(v);
    else if (k.startsWith("on")) (e as unknown as Record<string, unknown>)[k] = v;
    else if (v !== undefined && v !== null) e.setAttribute(k, String(v));
  }
  e.append(...(kids.flat(Infinity as 1) as (Node | string | null | undefined | false)[]).filter((k): k is Node | string => k !== null && k !== undefined && k !== false));
  return e;
}
