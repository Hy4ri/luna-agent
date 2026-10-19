export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(c => c?.type === 'text').map(c => c.text || '').join('\n\n') : '';
}
function date(timestamp?: number | string): Date | null {
  if (timestamp === undefined || timestamp === null || timestamp === '') return null;
  const value = new Date(timestamp);
  return Number.isFinite(value.getTime()) ? value : null;
}
export function formatTime(timestamp?: number | string): string {
  return date(timestamp)?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '';
}
export function formatDateIso(timestamp?: number | string): string { return date(timestamp)?.toISOString() || ''; }
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* Plain HTTP and clipboard permission failures use the browser copy fallback. */ }
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('aria-hidden', 'true');
  input.style.cssText = 'position:fixed;opacity:0;left:-9999px;top:0';
  try {
    document.body.appendChild(input); input.select();
    return document.execCommand('copy');
  } catch { return false; }
  finally { input.remove(); if (previous?.isConnected) previous.focus({ preventScroll: true }); }
}
