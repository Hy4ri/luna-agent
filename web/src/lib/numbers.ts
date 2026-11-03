/** Shared decimal count format. Promote rounded values to the next unit. */
export function compactNumber(value: number | null | undefined): string {
  const n = value ?? 0;
  if (!Number.isFinite(n)) return "—";
  const units = ["", "k", "m", "b", "t"];
  let unit = 0;
  let scaled = Math.abs(n);
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit++;
  }
  scaled = Number(scaled.toFixed(1));
  if (scaled >= 1000 && unit < units.length - 1) {
    scaled = Number((scaled / 1000).toFixed(1));
    unit++;
  }
  return `${n < 0 && scaled !== 0 ? "-" : ""}${scaled}${units[unit]}`;
}
