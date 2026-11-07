// Pure geometry for the browser canvas: map a pointer position on the letterboxed canvas to page coordinates.
export interface Box { left: number; top: number; width: number; height: number }

/** The canvas shows its bitmap with object-fit: contain. Returns null outside the picture. */
export function toPagePoint(
  clientX: number, clientY: number, box: Box,
  bitmap: { width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number } | null {
  if (!bitmap.width || !bitmap.height || !box.width || !box.height) return null;
  const scale = Math.min(box.width / bitmap.width, box.height / bitmap.height);
  const shownW = bitmap.width * scale, shownH = bitmap.height * scale;
  const px = clientX - box.left - (box.width - shownW) / 2;
  const py = clientY - box.top - (box.height - shownH) / 2;
  if (px < 0 || py < 0 || px > shownW || py > shownH) return null;
  const sx = (page.width || bitmap.width) / bitmap.width, sy = (page.height || bitmap.height) / bitmap.height;
  return { x: Math.round((px / scale) * sx), y: Math.round((py / scale) * sy) };
}

/** Add https:// to a bare host so the URL bar accepts "example.com". Anything else is returned as typed. */
export function normalizeUrl(input: string): string {
  const v = input.trim();
  if (!v) return v;
  return /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
}
