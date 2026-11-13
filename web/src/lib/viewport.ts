// Mobile keyboards can resize the visual viewport without changing CSS vh/dvh.
// Keep fixed overlays inside the same visible shell as the composer.
export function trackViewport(root: HTMLElement): () => void {
  if (typeof window === 'undefined') return () => {};
  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  let lastWidth = Math.round(viewport.width);
  let baselineHeight = Math.max(viewport.height, window.innerHeight);
  let settleTimer: number | undefined;

  const update = () => {
    // Preserve native pinch zoom: do not reflow the app while magnified.
    if (viewport.scale !== 1) return;

    const currentWidth = Math.round(viewport.width);
    if (Math.abs(currentWidth - lastWidth) > 40) {
      lastWidth = currentWidth;
      baselineHeight = Math.max(viewport.height, window.innerHeight);
    } else {
      baselineHeight = Math.max(baselineHeight, viewport.height, window.innerHeight);
    }

    const keyboardDelta = baselineHeight - viewport.height;
    const active = document.activeElement;
    const isTextInput =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable);
    const keyboardOpen = keyboardDelta > 120 && (isTextInput || keyboardDelta > 160);

    root.style.setProperty('--viewport-height', `${viewport.height}px`);
    root.style.setProperty('--viewport-width', `${viewport.width}px`);
    root.style.setProperty('--viewport-top', `${viewport.offsetTop}px`);
    root.style.setProperty('--keyboard-height', keyboardOpen ? `${Math.round(keyboardDelta)}px` : '0px');
    root.classList.toggle('keyboard-open', keyboardOpen);
  };

  const scheduleSettle = () => {
    update();
    if (settleTimer !== undefined) window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(update, 180);
  };

  update();
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', scheduleSettle);
  root.addEventListener('focusin', scheduleSettle);
  root.addEventListener('focusout', scheduleSettle);

  return () => {
    if (settleTimer !== undefined) window.clearTimeout(settleTimer);
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', scheduleSettle);
    root.removeEventListener('focusin', scheduleSettle);
    root.removeEventListener('focusout', scheduleSettle);
    root.style.removeProperty('--viewport-height');
    root.style.removeProperty('--viewport-width');
    root.style.removeProperty('--viewport-top');
    root.style.removeProperty('--keyboard-height');
    root.classList.remove('keyboard-open');
  };
}
