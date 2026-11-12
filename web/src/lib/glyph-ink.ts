// Visible-ink measurement for custom (emoji/text) project icons, shared by every ProjectIcon.
// Rasterizing a glyph at 4x and scanning every pixel was the costliest boot function (218-243 ms self time at
// 4x CPU): each icon did it three times, and the sidebar shows the same project icon in many rows.

const PIXEL_RATIO = 4;
export interface GlyphInk { source: HTMLCanvasElement; left: number; top: number; width: number; height: number }

const cache = new Map<string, GlyphInk | null>();
let scratch: CanvasRenderingContext2D | null | undefined;
let listening = false;

function measureContext(): CanvasRenderingContext2D | null {
  if (scratch === undefined) scratch = document.createElement("canvas").getContext("2d");
  return scratch;
}

/** A web font that finishes loading changes the pixels: measure again after that. */
function watchFonts() {
  if (listening || typeof document === "undefined" || !document.fonts) return;
  listening = true;
  document.fonts.addEventListener("loadingdone", () => cache.clear());
}

/** Label baseline offset: (font ascent - font descent - glyph ascent + glyph descent) / 2. */
export function labelCenterOffset(font: string, label: string): number {
  const context = measureContext();
  if (!context) return 0;
  context.font = font;
  const m = context.measureText(label);
  const offset = (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent - m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / 2;
  return Number.isFinite(offset) ? offset : 0;
}

/** The glyph's visible pixels, rasterized once per (glyph, font, color) until fonts change. Null: no ink. */
export function glyphInk(glyph: string, font: string, fontSize: number, color: string): GlyphInk | null {
  watchFonts();
  const key = `${font}\u0000${color}\u0000${glyph}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.font = font;
  const padding = Math.ceil(fontSize * 2);
  // Rasterize with room above and below the baseline. Color emoji font metrics
  // can describe the font cell rather than the pixels that are actually visible.
  context.canvas.width = Math.ceil((context.measureText(glyph).width + padding * 2) * PIXEL_RATIO);
  context.canvas.height = padding * 3 * PIXEL_RATIO;
  context.scale(PIXEL_RATIO, PIXEL_RATIO);
  context.font = font;
  context.fillStyle = color;
  context.fillText(glyph, padding, padding * 2);
  const { width, height } = context.canvas;
  const pixels = context.getImageData(0, 0, width, height).data;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (pixels[row + x * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      bottom = y;
    }
  }
  const ink = right < left || bottom < top ? null : { source: context.canvas, left, top, width: right - left + 1, height: bottom - top + 1 };
  cache.set(key, ink);
  return ink;
}
