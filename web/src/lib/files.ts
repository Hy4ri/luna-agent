/** Human-readable byte size. Empty for unknown sizes. */
export function formatFileSize(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Image types the browser can preview inline. */
export function isRasterImage(mimeType?: string): boolean {
  return /^image\/(png|jpeg|gif|webp)$/i.test(mimeType || "");
}
