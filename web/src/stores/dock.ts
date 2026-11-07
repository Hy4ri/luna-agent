// Work dock layout: where the dock sits (bottom or right) and how big it is. Terminal and browser panes share it.
import { reactive } from "vue";

export type DockPosition = "bottom" | "right";
export type DockPane = "terminal" | "browser";

const POSITION_KEY = "luna.dock.position";
const WIDTH_KEY = "luna.dock.width";
export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 120;
/** Below this width of the chat area the dock always sits at the bottom. */
export const SIDE_MIN_AREA = 900;

export const clampWidth = (px: number, available = window.innerWidth) =>
  Math.round(Math.min(Math.max(px, MIN_WIDTH), Math.max(MIN_WIDTH, available * 0.7)));
export const clampHeight = (px: number, available = window.innerHeight) =>
  Math.round(Math.min(Math.max(px, MIN_HEIGHT), Math.max(MIN_HEIGHT, available * 0.8)));
/** The saved choice, unless the chat area is too narrow for a side dock. */
export const effectivePosition = (saved: DockPosition, areaWidth: number): DockPosition => areaWidth < SIDE_MIN_AREA ? "bottom" : saved;

function read(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function write(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }

export function loadPosition(raw: string | null = read(POSITION_KEY)): DockPosition { return raw === "right" ? "right" : "bottom"; }
export function loadWidth(raw: string | null = read(WIDTH_KEY)): number {
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) && n >= MIN_WIDTH ? n : 420;
}

export const dock = reactive({
  position: loadPosition(),
  width: loadWidth(),
  /** Width of the chat area, measured by the app. Decides whether the side position fits. */
  area: Number.POSITIVE_INFINITY,
  pane: "terminal" as DockPane,
});

export function setPosition(position: DockPosition) { dock.position = position; write(POSITION_KEY, position); }
export function setWidth(px: number, available?: number) { dock.width = clampWidth(px, available); write(WIDTH_KEY, String(dock.width)); }
