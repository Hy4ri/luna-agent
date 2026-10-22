// A network document has its own CSP; srcdoc would inherit the desktop shell's
// script-src 'self' and block generated inline scripts. Never add allow-same-origin.
export const HTML_PREVIEW_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

// Only the embedding parent can deliver content. Drop the listener before running
// user scripts. The HTTP CSP survives document.write, including its opaque origin.
export const HTML_PREVIEW_SHELL = `<!doctype html>
<html><head><meta charset="utf-8"><title>HTML preview</title></head><body>
<script>
function receive(event) {
  if (event.source !== parent || event.data?.type !== 'luna:html-preview' || typeof event.data.html !== 'string') return;
  removeEventListener('message', receive);
  document.open();
  document.write(event.data.html);
  document.close();
}
addEventListener('message', receive);
parent.postMessage({ type: 'luna:html-preview-ready' }, '*');
</script>
</body></html>`;
