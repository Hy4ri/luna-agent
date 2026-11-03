// Use native tab clicks so keyboard navigation follows the same action guards.
export function handleTablistKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const root = event.currentTarget as HTMLElement;
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('button[role="tab"]')]
    .filter(tab => !tab.disabled && tab.getAttribute("aria-disabled") !== "true");
  const current = (event.target as HTMLElement).closest<HTMLButtonElement>('button[role="tab"]');
  const index = current ? tabs.indexOf(current) : -1;
  if (index < 0 || !tabs.length) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
    : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
  tabs[next]?.click();
  tabs[next]?.focus();
}
