// Mobile keyboards can resize the visual viewport without changing CSS vh/dvh.
// Keep fixed overlays inside the same visible shell as the composer.
export function trackViewport(root: HTMLElement): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const update = () => {
    // Preserve native pinch zoom: do not reflow the app while magnified.
    if (viewport.scale !== 1) return;
    root.style.setProperty('--viewport-height', `${viewport.height}px`);
    root.style.setProperty('--viewport-top', `${viewport.offsetTop}px`);
  };
  update();
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
    root.style.removeProperty('--viewport-height');
    root.style.removeProperty('--viewport-top');
  };
}
