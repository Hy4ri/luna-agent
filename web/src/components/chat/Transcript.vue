<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from "vue";
import { ArrowDown, X } from "@lucide/vue";
import { chat, entryList, activityLabel, dismissNotice, openSession, loadOlderEntries, userIndexFor, refreshUserIndex, ensureEntryLoaded } from "@/stores/chat";
import { pendingMessages } from "@/stores/composer";
import { messageText } from "@/lib/message";
import { parsePeerMessage } from "@/lib/peer-message";
import ReportContext from "./ReportContext.vue";
import AssistantText from "./AssistantText.vue";
import { assistantTextBlocks, mediaDirectives } from "@/lib/media";
import MessageFooter from "./MessageFooter.vue";
import ToolCall from "./ToolCall.vue";
import SideJobCard from "./SideJobCard.vue";
import Welcome from "./Welcome.vue";
import Questions from "./Questions.vue";
import PendingMessage from "./PendingMessage.vue";
import UploadAttachment from "./UploadAttachment.vue";
import SessionImage from "./SessionImage.vue";
import ScheduledMessages from "./ScheduledMessages.vue";

const pending = computed(() => [...pendingMessages.values()].filter(p =>
  p.session === chat.session && (p.session !== null || p.epoch === chat.epoch) &&
  !entryList.value.some(e => e.id === p.entryId)));
// Queued input waits outside the scrolling log, docked above the composer.
const queued = computed(() => pending.value.filter(p => p.status === "Queued" || p.status === "Steering"));
const inLog = computed(() => pending.value.filter(p => p.status !== "Queued" && p.status !== "Steering"));
const logRef = ref<HTMLElement | null>(null);
const jumpRef = ref<HTMLElement | null>(null);
// The jump button shows only while the user scrolls, then hides again.
const IDLE_MS = 1500;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
function hideJumps() {
  if (jumpRef.value) jumpRef.value.hidden = true;
}
// A programmatic follow updates the jump button too.
function updateJumps(log: HTMLElement) {
  if (jumpRef.value) jumpRef.value.hidden = !newerHidden.value && log.scrollHeight - log.scrollTop - log.clientHeight < 200;
}
// Follow new content only while the user sits at the bottom.
// Only user input can stop following. Scroll events also come from clamping, scroll anchoring,
// and our own writes, and they fire after later content growth, so their position is unreliable.
const BOTTOM_PX = 48;
const INTENT_MS = 600;
let pinned = true;
let intentUntil = 0;
let dragging = false;
const distance = (log: HTMLElement) => log.scrollHeight - log.scrollTop - log.clientHeight;
// Coalesce follow-scrolls into one write per display frame.
let scrollRaf: number | undefined;
function scroll(force = false) {
  if (force) {
    pinned = true;
    // Following needs the newest rows. Return to the bounded newest window instead of rendering every row below a jump.
    if (newerHidden.value) { newerFrom.value = null; visibleCount.value = WINDOW_INITIAL; }
  }
  if (scrollRaf !== undefined || !logRef.value) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = undefined;
    const log = logRef.value;
    if (!log || !pinned) return;
    log.scrollTop = log.scrollHeight;
    updateJumps(log);
  });
}
function jumpToBottom() {
  scroll(true);
  showJumps();
}
function showJumps() {
  if (logRef.value) updateJumps(logRef.value);
  clearTimeout(idleTimer);
  idleTimer = setTimeout(hideJumps, IDLE_MS);
}
function markIntent() { intentUntil = Date.now() + INTENT_MS; }
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
// Typing in the composer or any field never scrolls the log.
function handleKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
  if (SCROLL_KEYS.has(event.key)) markIntent();
}
// Scrollbar drags have no wheel or touch event. Pointer-down on the log itself, not its content.
function handlePointerDown(event: PointerEvent) { if (event.target === logRef.value) dragging = true; }
function handlePointerUp() { dragging = false; }
function handleScroll() {
  const log = logRef.value;
  if (!log) return;
  const userScroll = dragging || Date.now() < intentUntil;
  // With newer rows unrendered, the bottom of the log is not the end of the conversation.
  // Do not re-pin while a rail jump is smoothly scrolling away from the bottom.
  if (distance(log) < BOTTOM_PX && !newerHidden.value && (jumpingToId === null || userScroll)) pinned = true;
  else if (userScroll) pinned = false;
  if (userScroll) showJumps();
  if (newerHidden.value && distance(log) < NEWER_MARGIN_PX) void expandNewerWindow();
  scheduleActive();
}
// Follow every layout change while pinned: DOM changes, log resizes (composer, extras),
// image loads, and disclosure toggles. None of these reliably emit a scroll event.
let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;
const follow = () => scroll();
onMounted(() => {
  const log = logRef.value;
  if (!log) return;
  resizeObserver = new ResizeObserver(follow);
  resizeObserver.observe(log);
  mutationObserver = new MutationObserver(follow);
  mutationObserver.observe(log, { childList: true, subtree: true, characterData: true });
  log.addEventListener("load", follow, true);
  log.addEventListener("toggle", follow, true);
  log.addEventListener("contentvisibilityautostatechange", follow, true);
  window.addEventListener("keydown", handleKey, true);
  window.addEventListener("pointerup", handlePointerUp, true);
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  mutationObserver?.disconnect();
  window.removeEventListener("keydown", handleKey, true);
  window.removeEventListener("pointerup", handlePointerUp, true);
  clearTimeout(idleTimer);
  if (scrollRaf !== undefined) cancelAnimationFrame(scrollRaf);
});
// Show newly arrived clarifications at their start, without creating a second scroll area.
watch(() => chat.extras?.questions, (questions, previous) => {
  const added = questions?.find(q => !previous?.some(old => old.callId === q.callId));
  void nextTick(() => {
    const log = logRef.value;
    const form = added && document.querySelector<HTMLElement>(`[data-ask="${CSS.escape(added.callId)}"]`);
    // Scroll only the log. scrollIntoView also scrolls overflow:hidden ancestors and pushes the composer up.
    if (!log || !form) return;
    log.scrollTop += form.getBoundingClientRect().top - log.getBoundingClientRect().top - 24;
    // Keep the question start in view; do not let the follow pull it away.
    pinned = distance(log) < BOTTOM_PX;
  });
});
// Sending or opening a conversation is explicit intent to follow. The frame runs after Vue renders.
watch(() => chat.followTick, () => scroll(true), { flush: "sync" });
// Preserve scroll position when streaming ends and .live-message is replaced by a durable entry.
watch(() => Boolean(chat.liveText || chat.liveThinking), (live, wasLive) => {
  if (!wasLive || live || pinned) return;
  const log = logRef.value;
  if (!log) return;
  const epoch = chat.epoch;
  const logRect = log.getBoundingClientRect();
  const rows = log.querySelectorAll<HTMLElement>("#log > .msg, #log > details, #log > .side-job-card");
  let anchorEl: HTMLElement | null = null;
  let anchorOffset = 0;
  let anchoredToLive = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const r = row.getBoundingClientRect();
    if (r.bottom > logRect.top) {
      anchorEl = row;
      anchorOffset = r.top - logRect.top;
      anchoredToLive = row.classList.contains("live-message");
      break;
    }
  }
  if (!anchorEl) return;
  const assistantEls = anchoredToLive ? log.querySelectorAll<HTMLElement>("#log > .msg.assistant[data-entry]") : null;
  const prevEntryId = assistantEls?.length ? assistantEls[assistantEls.length - 1]!.dataset.entry : undefined;
  void nextTick(() => {
    if (chat.epoch !== epoch || pinned || logRef.value !== log) return;
    const nextLogRect = log.getBoundingClientRect();
    if (anchoredToLive) {
      const nextAssistants = log.querySelectorAll<HTMLElement>("#log > .msg.assistant[data-entry]");
      const newEl = nextAssistants.length ? nextAssistants[nextAssistants.length - 1]! : null;
      if (!newEl || newEl.dataset.entry === prevEntryId) return;
      const diff = (newEl.getBoundingClientRect().top - nextLogRect.top) - anchorOffset;
      if (diff !== 0) log.scrollTop += diff;
    } else if (anchorEl.isConnected) {
      const diff = (anchorEl.getBoundingClientRect().top - nextLogRect.top) - anchorOffset;
      if (diff !== 0) log.scrollTop += diff;
    }
  });
}, { flush: "pre" });
// Merge side reports at their start time, rather than pinning them after every later turn.
// Keep durable entry order, including entries that do not contribute model messages.
const timeline = computed((): { key: string; entry?: any; job?: any }[] => {
  // Most turns have no side jobs. Return entries directly: no spread, filter, sort, or per-entry timestamp scan.
  if (!chat.sideJobs.size) return entryList.value.map((entry: any) => ({ key: `entry:${entry.id}`, entry }));
  const jobs = [...chat.sideJobs.values()].filter(j => j.kind !== "review").sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const rows: { key: string; entry?: any; job?: any }[] = [];
  let at = 0;
  for (const entry of entryList.value) {
    const timestamp = entry.model?.find((m: any) => Number.isFinite(m.timestamp))?.timestamp;
    while (at < jobs.length && Number.isFinite(timestamp) && jobs[at]!.createdAt < timestamp) {
      const job = jobs[at++]!;
      rows.push({ key: `side:${job.id}`, job });
    }
    rows.push({ key: `entry:${entry.id}`, entry });
  }
  for (const job of jobs.slice(at)) rows.push({ key: `side:${job.id}`, job });
  return rows;
});
// Paint the newest rows first and keep DOM size bounded during streaming.
// Older rows of the session are revealed as the user scrolls up via an IntersectionObserver sentinel.
const WINDOW_INITIAL = 35;
const WINDOW_EXPAND_STEP = 35;
const visibleCount = ref(WINDOW_INITIAL);
// A rail jump far back renders rows around the target, not every row down to the newest. newerFrom is the key
// of the first unrendered newer row; null renders through the newest row. Keys stay valid when rows arrive.
const newerFrom = ref<string | null>(null);
const topSentinelRef = ref<HTMLElement | null>(null);
let sentinelObserver: IntersectionObserver | undefined;

function resetWindow() {
  visibleCount.value = WINDOW_INITIAL;
  newerFrom.value = null;
}
watch(() => chat.epoch, resetWindow);

function windowEndIn(rows: { key: string }[]) {
  const at = newerFrom.value === null ? -1 : rows.findIndex(row => row.key === newerFrom.value);
  return at < 0 ? rows.length : at;
}
const windowEnd = computed(() => windowEndIn(timeline.value));
const newerHidden = computed(() => windowEnd.value < timeline.value.length);
const hasOlderWindowRows = computed(() => windowEnd.value > visibleCount.value);
// The window is visibleCount rows ending at windowEnd. A reader scrolled up must not lose rows above the viewport
// when new rows arrive (only Chromium's scroll anchoring would hide the jump): keep the first shown row in place.
// Pinned to the bottom, the window slides and the DOM stays bounded.
watch(() => timeline.value, (rows, old) => {
  if (pinned || !old) return;
  const oldEnd = windowEndIn(old), end = windowEndIn(rows);
  if (end <= visibleCount.value || oldEnd <= visibleCount.value) return;
  const first = old[oldEnd - visibleCount.value]?.key;
  const at = first === undefined ? -1 : rows.findIndex(row => row.key === first);
  if (at >= 0) visibleCount.value = end - at;
}, { flush: "sync" });
const shownTimeline = computed(() => {
  const end = windowEnd.value;
  if (end === timeline.value.length && end <= visibleCount.value) return timeline.value;
  return timeline.value.slice(Math.max(0, end - visibleCount.value), end);
});
// Reveal newer rows as the reader nears the bottom of the window. A rail jump holds this off until it has placed
// its target. Past WINDOW_MAX_ROWS the oldest shown rows leave as newer ones arrive, so every render stays bounded;
// the top sentinel brings them back when the reader scrolls up.
const NEWER_MARGIN_PX = 800;
const WINDOW_MAX_ROWS = 150;
let expandingNewer = false;
let jumpHold = false;
async function expandNewerWindow() {
  if (expandingNewer || jumpHold) return;
  expandingNewer = true;
  try {
    for (let i = 0; i < 5 && newerHidden.value; i++) {
      const log = logRef.value;
      if (!log || distance(log) > NEWER_MARGIN_PX) break;
      const next = windowEnd.value + WINDOW_EXPAND_STEP;
      const trims = visibleCount.value + WINDOW_EXPAND_STEP > WINDOW_MAX_ROWS;
      const restore = trims ? anchorFirstVisibleRow() : () => {};
      newerFrom.value = next >= timeline.value.length ? null : timeline.value[next]!.key;
      visibleCount.value = Math.max(visibleCount.value, Math.min(visibleCount.value + WINDOW_EXPAND_STEP, WINDOW_MAX_ROWS));
      await nextTick();
      restore();
    }
  } finally {
    expandingNewer = false;
  }
}

/** Keeps the first visible row in place across a change of the rows above it. Call the result after the render. */
function anchorFirstVisibleRow(): () => void {
  const log = logRef.value;
  if (!log) return () => {};
  const logRect = log.getBoundingClientRect();
  const rows = log.querySelectorAll<HTMLElement>("#log > .msg, #log > details, #log > .side-job-card");
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!.getBoundingClientRect();
    if (r.bottom <= logRect.top) continue;
    const anchorEl = rows[i]!, anchorOffset = r.top - logRect.top;
    return () => {
      if (!anchorEl.isConnected) return;
      const diff = (anchorEl.getBoundingClientRect().top - log.getBoundingClientRect().top) - anchorOffset;
      if (diff !== 0) log.scrollTop += diff;
    };
  }
  return () => {};
}

async function expandOlderWindow() {
  if (!hasOlderWindowRows.value) return;
  const restore = anchorFirstVisibleRow();
  visibleCount.value = Math.min(timeline.value.length, visibleCount.value + WINDOW_EXPAND_STEP);
  await nextTick();
  restore();
}

function setupSentinel() {
  sentinelObserver?.disconnect();
  sentinelObserver = undefined;
  const log = logRef.value;
  const sentinel = topSentinelRef.value;
  if (!log || !sentinel) return;
  sentinelObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && hasOlderWindowRows.value) {
        void expandOlderWindow();
      }
    }
  }, { root: log, rootMargin: "400px 0px 0px 0px" });
  sentinelObserver.observe(sentinel);
}

watch(topSentinelRef, () => {
  setupSentinel();
});

onMounted(() => {
  setupSentinel();
});

onBeforeUnmount(() => {
  sentinelObserver?.disconnect();
});
// Rail of thin ticks, one per user message. A click scrolls the log to that message.
const userTicks = computed(() => {
  // Loaded entries first (they update live), then the server index for entries not loaded yet.
  const loaded: { id: number; label: string }[] = [];
  for (const row of timeline.value) {
    const entry = row.entry;
    // These kinds render as muted rows (see the template), never as a user message.
    if (!entry || entry.kind === 'pi.reset' || entry.kind === 'pi.compaction' || entry.kind === 'luna.model-changed') continue;
    for (const m of entry.model || []) {
      if (m.role !== 'user' || backgroundReport(entry, m)) continue;
      const text = messageText(m.content).replace(/\s+/g, ' ').trim();
      loaded.push({ id: entry.id, label: text.length > 120 ? text.slice(0, 120) + '…' : text || 'Message' });
      break;
    }
  }
  const indexed = userIndexFor(chat.session);
  if (!indexed.length) return loaded;
  const seen = new Set(loaded.map(t => t.id));
  const minLoaded = loaded.length ? loaded[0]!.id : Infinity;
  const older = indexed.filter(t => !seen.has(t.id) && t.id < minLoaded);
  return [...older, ...loaded];
});
const activeTick = ref<number | null>(null);
let railRaf: number | undefined;
let jumpingToId: number | null = null;
let jumpStartedAt = 0;
function userEl(id: number) {
  // Peer reports are user messages too, but they render as a disclosure, not as .msg.user.
  const key = CSS.escape(String(id));
  return logRef.value?.querySelector<HTMLElement>(`.msg.user[data-entry="${key}"], .agent-report[data-entry="${key}"]`) ?? null;
}
function updateActive() {
  railRaf = undefined;
  if (jumpingToId !== null) {
    if (!dragging && intentUntil <= jumpStartedAt + INTENT_MS) return;
    jumpingToId = null;
  }
  const log = logRef.value;
  if (!log || !userTicks.value.length) { activeTick.value = null; return; }
  const box = log.getBoundingClientRect();
  // The active message is the last one that starts near the top, where jumpToUser places it (24px), so
  // short stacked reports do not steal the highlight. At the bottom the log cannot scroll further and the
  // newest message on screen may never reach that line: use the bottom edge instead.
  const line = distance(log) < 4 && !newerHidden.value ? box.bottom : box.top + 64;
  let current = userTicks.value[0]!.id;
  for (const t of userTicks.value) {
    const el = userEl(t.id);
    if (el && el.getBoundingClientRect().top <= line) current = t.id;
  }
  activeTick.value = current;
}
function scheduleActive() { if (railRaf === undefined) railRaf = requestAnimationFrame(updateActive); }
watch(userTicks, scheduleActive, { flush: "post" });
let lastIndexed = -1;
watch(() => userTicks.value.length, (n) => { if (chat.session && n > lastIndexed && lastIndexed >= 0 && !chat.loadingOlder) void refreshUserIndex(); lastIndexed = n; });
onBeforeUnmount(() => { if (railRaf !== undefined) cancelAnimationFrame(railRaf); });

const railRef = ref<HTMLElement | null>(null);
const railCardRef = ref<HTMLElement | null>(null);
const hoveredTickIdx = ref<number | null>(null);
const focusedTickIdx = ref<number | null>(null);
const railCardY = ref(0);
const activeTickIdx = computed(() => userTicks.value.findIndex(t => t.id === activeTick.value));
const previewTickIdx = computed(() => hoveredTickIdx.value ?? focusedTickIdx.value);
const focalTickIdx = computed(() => previewTickIdx.value ?? (activeTickIdx.value >= 0 ? activeTickIdx.value : 0));
const previewTick = computed(() => previewTickIdx.value !== null ? userTicks.value[previewTickIdx.value] ?? null : null);

const railGap = computed(() => {
  const n = userTicks.value.length;
  if (n > 75) return "1px";
  return "1.5px";
});

function railCurve(index: number, center: number, total: number): number {
  const d = Math.abs(index - center);
  const maxDist = Math.max(center, total - 1 - center);
  if (maxDist <= 0) return 1;
  const t = d / maxDist;
  return (1 - t) ** 2;
}

function railTickStyle(index: number): Record<string, string> {
  const total = userTicks.value.length;
  const focal = focalTickIdx.value;
  const activeIdx = activeTickIdx.value >= 0 ? activeTickIdx.value : 0;
  const curve = railCurve(index, focal, total);
  // Anchor vertical slot size to the active tick so hovering never shifts ticks under the pointer.
  const spaceCurve = railCurve(index, activeIdx, total);
  const isActive = index === activeTickIdx.value;
  const isPreview = index === previewTickIdx.value;
  const minW = 5;
  const maxW = 20;
  const width = minW + (maxW - minW) * curve;
  const opacity = isActive || isPreview ? 1 : 0.3 + 0.7 * curve;
  const slotFlex = 1 + 1.0 * spaceCurve;
  const slotMax = 6 + 7 * spaceCurve;
  return {
    "--tick-w": `${width.toFixed(2)}px`,
    "--tick-op": opacity.toFixed(2),
    "--tick-flex": slotFlex.toFixed(2),
    "--tick-slot": `${slotMax.toFixed(1)}px`,
  };
}

function updateRailCardY(targetEl: HTMLElement | null) {
  const rail = railRef.value;
  if (!rail || !targetEl) return;
  const cardHeight = railCardRef.value?.offsetHeight || 36;
  const center = targetEl.offsetTop + targetEl.offsetHeight / 2 - cardHeight / 2;
  const maxTop = Math.max(0, rail.clientHeight - cardHeight + 24);
  railCardY.value = Math.max(-24, Math.min(maxTop, center));
}

function onTickHover(index: number, event: Event) {
  hoveredTickIdx.value = index;
  const targetEl = event.currentTarget as HTMLElement | null;
  updateRailCardY(targetEl);
  void nextTick(() => {
    if (hoveredTickIdx.value === index) updateRailCardY(targetEl);
  });
}

function onRailLeave() {
  hoveredTickIdx.value = null;
}

function onTickFocus(index: number, event: FocusEvent) {
  const targetEl = event.currentTarget as HTMLElement | null;
  if (!targetEl?.matches(":focus-visible")) return;
  focusedTickIdx.value = index;
  updateRailCardY(targetEl);
  void nextTick(() => {
    if (focusedTickIdx.value === index) updateRailCardY(targetEl);
  });
}

function onTickBlur(index: number) {
  if (focusedTickIdx.value === index) focusedTickIdx.value = null;
}

watch(() => chat.session, () => {
  hoveredTickIdx.value = null;
  focusedTickIdx.value = null;
  jumpingToId = null;
});

watch(() => userTicks.value.length, (len) => {
  if (hoveredTickIdx.value !== null && hoveredTickIdx.value >= len) hoveredTickIdx.value = null;
  if (focusedTickIdx.value !== null && focusedTickIdx.value >= len) focusedTickIdx.value = null;
});
const JUMP_CONTEXT_ROWS = 5;
let jumpSeq = 0;
let cancelActiveJump: (() => void) | undefined;
async function jumpToUser(id: number) {
  cancelActiveJump?.();
  cancelActiveJump = undefined;
  const jump = ++jumpSeq, epoch = chat.epoch, startedAt = Date.now();
  jumpingToId = id;
  jumpStartedAt = startedAt;
  activeTick.value = id;
  if (!userEl(id)) {
    // Older entries are not loaded yet: load pages until this one exists.
    const sid = chat.session;
    if (!(await ensureEntryLoaded(id)) || chat.session !== sid || jump !== jumpSeq) {
      if (jump === jumpSeq) { jumpingToId = null; jumpHold = false; }
      return;
    }
  }
  // Outside the rendered window: render a window around the target, not every row from it to the newest.
  const targetIndex = timeline.value.findIndex(row => row.entry?.id === id);
  const end = windowEnd.value;
  if (targetIndex >= 0 && (targetIndex < end - visibleCount.value || targetIndex >= end)) {
    pinned = false;
    // The new window clamps the scroll position; that is not the reader nearing the bottom.
    jumpHold = true;
    const rows = timeline.value, start = Math.max(0, targetIndex - JUMP_CONTEXT_ROWS);
    let stop = Math.min(rows.length, targetIndex + WINDOW_INITIAL);
    // A short hidden tail is not worth a second load step.
    if (rows.length - stop < WINDOW_EXPAND_STEP) stop = rows.length;
    newerFrom.value = stop >= rows.length ? null : rows[stop]!.key;
    visibleCount.value = stop - start;
  }
  await nextTick();
  if (jump !== jumpSeq || chat.epoch !== epoch) return;
  const log = logRef.value, el = userEl(id);
  if (!log || !el) { jumpHold = false; jumpingToId = null; return; }
  pinned = false;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const offset = () => el.getBoundingClientRect().top - log.getBoundingClientRect().top - 24;
  const maxScroll = Math.max(0, log.scrollHeight - log.clientHeight);
  const targetTop = Math.max(0, Math.min(maxScroll, log.scrollTop + offset()));
  const actualDelta = targetTop - log.scrollTop;
  log.scrollTo({ top: targetTop, behavior: reduce ? "auto" : "smooth" });
  // Rows off screen use estimated heights (content-visibility), so the target moves while they render.
  // Snap it into place when the scroll ends, unless the reader scrolled meanwhile.
  const settle = (tries: number, onSettled: () => void) => {
    // Any wheel, touch, or scroll key since the jump started (intentUntil = last intent + INTENT_MS) leaves it alone.
    if (jump !== jumpSeq || chat.epoch !== epoch || !el.isConnected || intentUntil > startedAt + INTENT_MS || dragging) {
      onSettled();
      return;
    }
    const delta = offset();
    if (Math.abs(delta) <= 4) { onSettled(); return; }
    log.scrollTop += delta;
    if (tries > 0) requestAnimationFrame(() => requestAnimationFrame(() => settle(tries - 1, onSettled)));
    else onSettled();
  };
  const done = () => {
    clearTimeout(fallback); log.removeEventListener("scrollend", done);
    if (cancelActiveJump === cancel) cancelActiveJump = undefined;
    settle(3, () => {
      if (jump === jumpSeq) {
        jumpHold = false;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (jump === jumpSeq) jumpingToId = null;
        }));
      }
    });
  };
  const cancel = () => {
    clearTimeout(fallback);
    log.removeEventListener("scrollend", done);
  };
  cancelActiveJump = cancel;
  const fallback = setTimeout(done, reduce || Math.abs(actualDelta) <= 1 ? 50 : 1500);
  log.addEventListener("scrollend", done);
  el.classList.remove("rail-flash");
  void el.offsetWidth;
  el.classList.add("rail-flash");
  setTimeout(() => el.classList.remove("rail-flash"), 1400);
}
const results = computed(() => {
  const map = new Map<string, any>(Object.entries(chat.toolResults));
  for (const entry of entryList.value) for (const message of entry.model || []) {
    if (message.role === 'toolResult') map.set(message.toolCallId, { ...message, entryId: entry.id });
  }
  return map;
});
const calls = computed(() => {
  // Same membership as before, but direct loops instead of nested flatMap intermediate arrays.
  const set = new Set<string>();
  for (const entry of entryList.value) {
    const model = entry.model;
    if (!model) continue;
    for (const message of model) for (const c of blocks(message.content)) if (c.type === "toolCall") set.add(c.id);
  }
  return set;
});
const durableResults = computed(() => {
  const set = new Set<string>();
  for (const entry of entryList.value) {
    const model = entry.model;
    if (!model) continue;
    for (const m of model) if (m.role === "toolResult") set.add(m.toolCallId);
  }
  return set;
});
/** First media index of each assistant text block, numbered like the server's entry media route. */
const mediaOffsets = computed(() => {
  const map = new Map<string, number>();
  for (const entry of entryList.value) {
    let n = 0;
    for (const b of assistantTextBlocks(entry.model)) { map.set(`${entry.id}:${b.message}:${b.block}`, n); n += mediaDirectives(b.text).length; }
  }
  return map;
});
const mediaBase = (entry: any) => `/v1/sessions/${encodeURIComponent(chat.session || '')}/entries/${entry.id}/media`;
function blocks(content: unknown): any[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
}
function peerMessage(entry: any, message: any) {
  const parsed = parsePeerMessage(entry, messageText(message.content));
  return parsed?.kind === "peer" ? parsed : undefined;
}
function peerReport(entry: any, message: any) {
  const parsed = parsePeerMessage(entry, messageText(message.content));
  return parsed && parsed.kind !== "peer" ? parsed : undefined;
}
function backgroundReport(entry: any, message: any): boolean {
  // Background commands predate origin metadata. Match only their exact producer header.
  return entry.kind === 'pi.user' && /^Background process [a-f0-9-]+ finished:/.test(messageText(message.content));
}
</script>

<template>
  <div id="log" ref="logRef" role="region" aria-label="Conversation" @scroll="handleScroll" @wheel.passive="markIntent" @touchmove.passive="markIntent" @pointerdown="handlePointerDown">
    <div v-if="chat.hasMoreEntries && !hasOlderWindowRows" class="load-older-bar">
      <button
        type="button"
        class="load-older-btn"
        :disabled="chat.loadingOlder"
        @click="loadOlderEntries"
      >
        {{ chat.loadingOlder ? "Loading older messages…" : "Load older messages" }}
      </button>
    </div>
    <div ref="topSentinelRef" class="top-sentinel" aria-hidden="true" />
    <Welcome v-if="!entryList.length && !pending.length && !chat.liveText && !chat.liveThinking && !chat.sideJobs.size && !activityLabel" />
    <template v-for="row in shownTimeline" :key="row.key">
      <SideJobCard v-if="row.job" :job="row.job" class="vl vl-lg" />
      <template v-else v-for="entry in [row.entry]" :key="entry.id">
        <div v-if="entry.kind === 'pi.reset'" class="msg muted vl vl-lg">— context reset —</div>
        <div v-else-if="entry.kind === 'pi.compaction'" class="msg muted vl vl-lg">— earlier messages compacted —</div>
        <div v-else-if="entry.kind === 'luna.model-changed'" class="msg muted vl vl-lg">{{ entry.data?.text }}</div>
        <template v-else v-for="(message, mi) in (entry.model || [])" :key="mi">
          <details v-if="message.role === 'user' && backgroundReport(entry, message)" class="background-report" :data-entry="entry.id">
            <summary>Background report</summary>
            <pre dir="auto">{{ messageText(message.content) }}</pre>
            <MessageFooter :text="messageText(message.content)" :timestamp="message.timestamp" :entry-id="entry.id" />
          </details>
          <details v-else-if="message.role === 'user' && peerReport(entry, message)" class="agent-report vl vl-lg" :class="peerReport(entry, message)!.kind" :data-entry="entry.id">
            <summary>
              <span class="agent-report-kind">{{ peerReport(entry, message)!.kind === 'crew-report' ? 'Crew report' : 'Subagent report' }}</span>
              <span v-if="peerReport(entry, message)!.state" class="agent-report-state">{{ peerReport(entry, message)!.state }}</span>
              <span class="agent-report-peer">#{{ peerReport(entry, message)!.from }} {{ peerReport(entry, message)!.title }}</span>
            </summary>
            <div class="agent-report-actions">
              <button type="button" class="peer-chip" :data-peer="peerReport(entry, message)!.from" :title="'Open session #' + peerReport(entry, message)!.from" @click="openSession(peerReport(entry, message)!.from)">Open session #{{ peerReport(entry, message)!.from }}</button>
            </div>
            <div dir="auto" class="agent-report-body rtl-plaintext">{{ peerReport(entry, message)!.body }}</div>
            <MessageFooter :text="peerReport(entry, message)!.body" :timestamp="message.timestamp" :entry-id="entry.id" />
          </details>
          <div v-else-if="message.role === 'user' && peerMessage(entry, message)" class="msg user peer vl vl-lg" :data-entry="entry.id">
            <button type="button" class="peer-chip" :data-peer="peerMessage(entry, message)!.from" :title="'Open session #' + peerMessage(entry, message)!.from" @click="openSession(peerMessage(entry, message)!.from)">From #{{ peerMessage(entry, message)!.from }} {{ peerMessage(entry, message)!.title }}</button>
            <div dir="auto" class="user-content rtl-plaintext">{{ peerMessage(entry, message)!.body }}</div>
            <MessageFooter :text="peerMessage(entry, message)!.body" :timestamp="message.timestamp" :entry-id="entry.id" />
          </div>
          <div v-else-if="message.role === 'user'" class="msg user vl vl-lg" :data-entry="entry.id">
            <div dir="auto" class="user-content rtl-plaintext">
              <template v-for="(block, bi) in blocks(message.content)" :key="bi">
                <UploadAttachment
                  v-if="block.attachment"
                  :upload-id="block.attachment.id || block.uploadId"
                  :name="block.attachment.name || 'upload'"
                  :mime-type="block.attachment.mimeType"
                  :size="block.attachment.size"
                />
                <ReportContext v-else-if="block.type === 'text'" :text="block.text" />
                <SessionImage
                  v-else-if="block.type === 'image' && !block.data?.startsWith('luna-upload:')"
                  class="att"
                  :image="block"
                  alt="attachment"
                />
              </template>
            </div>
            <MessageFooter :text="messageText(message.content)" :timestamp="message.timestamp" :entry-id="entry.id" />
          </div>
          <div v-else-if="message.role === 'assistant'" class="msg assistant vl vl-xl" :data-entry="entry.id">
            <template v-for="(block, bi) in blocks(message.content)" :key="bi">
              <AssistantText v-if="block.type === 'text' && block.text" :text="block.text" :base="mediaBase(entry)" :offset="mediaOffsets.get(`${entry.id}:${mi}:${bi}`) ?? 0" />
              <details v-else-if="block.type === 'thinking' && block.thinking" class="thinking">
                <summary>Thinking</summary>
                <pre dir="auto">{{ block.thinking }}</pre>
              </details>
              <ToolCall v-else-if="block.type === 'toolCall'" :id="block.id" :name="block.name" :args="block.arguments" :result="results.get(block.id)" :timestamp="message.timestamp" />
            </template>
            <div dir="auto" v-if="message.stopReason === 'error' && message.errorMessage" class="msg err">{{ message.errorMessage }}</div>
            <MessageFooter v-if="messageText(message.content)" :text="messageText(message.content)" :timestamp="message.timestamp" :entry-id="entry.id" />
          </div>
          <ToolCall v-else-if="message.role === 'toolResult' && !calls.has(message.toolCallId)" :id="message.toolCallId" :name="message.toolName || 'tool'" :args="chat.toolStarts[message.toolCallId]?.args" :result="{ ...message, entryId: entry.id }" />
        </template>
    </template>
    </template>
    <!-- Live calls without a durable entry yet. Nested calls (codemode children) are always hidden here;
         they render inside the parent codemode ToolCall card in real-time instead. -->
    <!-- Newer rows past a rail jump load as the reader scrolls down. The live tail belongs after the newest row. -->
    <template v-if="!newerHidden">
      <template v-for="(tool, id) in chat.toolStarts" :key="id">
        <ToolCall v-if="!calls.has(id) && !durableResults.has(id) && !tool.parentCallId" :id="id" :name="tool.name" :args="tool.args" :result="results.get(id)" :timestamp="tool.timestamp" />
      </template>
      <PendingMessage v-for="message in inLog" :key="message.requestId" :message="message" />
      <div v-if="chat.liveText || chat.liveThinking" class="msg assistant live-message vl vl-xl">
        <details v-if="chat.liveThinking" class="thinking"><summary>Thinking</summary><pre dir="auto">{{ chat.liveThinking }}</pre></details>
        <AssistantText v-if="chat.liveText" :text="chat.liveText" :streaming="true" />
      </div>
      <div v-for="notice in chat.notices" :key="notice.id" :data-notice="notice.id" :class="['msg', 'chat-notice', notice.kind === 'err' ? 'err' : 'muted']">
        <span dir="auto">{{ notice.text }}</span>
        <button type="button" aria-label="Dismiss notice" title="Dismiss notice" @click="dismissNotice(notice.id)"><X :size="16" aria-hidden="true" /></button>
      </div>
      <div v-if="activityLabel" id="activity" role="status" aria-live="polite" aria-atomic="true">
        <span>{{ activityLabel }}</span>
      </div>
      <!-- Context that belongs to the conversation, not to the composer: it renders as the last
           row of the scroller, so a wheel or swipe that starts on it scrolls the transcript. -->
      <slot />
      <ScheduledMessages />
      <Questions />
    </template>
  </div>
  <div v-if="queued.length" class="queued-dock" role="region" aria-label="Queued messages">
    <PendingMessage v-for="message in queued" :key="message.requestId" :message="message" />
  </div>
  <nav v-if="userTicks.length > 1" ref="railRef" class="user-rail" :style="{ '--rail-gap': railGap }" aria-label="User messages" @mouseleave="onRailLeave">
    <button
      v-for="(t, i) in userTicks"
      :key="t.id"
      type="button"
      class="user-tick"
      :class="{ active: t.id === activeTick, hovered: i === previewTickIdx }"
      :style="railTickStyle(i)"
      :aria-label="'Go to message: ' + t.label"
      :aria-current="t.id === activeTick ? 'true' : undefined"
      @mouseenter="onTickHover(i, $event)"
      @focus="onTickFocus(i, $event)"
      @blur="onTickBlur(i)"
      @click="jumpToUser(t.id)"
    ><span class="tick-bar" /></button>
    <div
      ref="railCardRef"
      class="rail-card"
      :class="{ open: !!previewTick, active: previewTickIdx === activeTickIdx }"
      :style="{ '--card-y': railCardY + 'px' }"
      :aria-hidden="!previewTick"
    >
      <span class="rail-card-idx">#{{ (previewTickIdx ?? 0) + 1 }}</span>
      <span class="rail-card-body" dir="auto">{{ previewTick?.label }}</span>
    </div>
  </nav>
  <div class="transcript-jumps">
    <button id="jump" ref="jumpRef" type="button" hidden aria-label="Jump to bottom" title="Jump to bottom" @click="jumpToBottom"><ArrowDown :size="18" aria-hidden="true" /></button>
  </div>
</template>

<style scoped>
.user-rail {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%); z-index: 5;
  display: flex; flex-direction: column; gap: var(--rail-gap, clamp(2px, 0.35vh, 4px)); width: 28px; height: min(68%, 480px);
  padding: 6px 2px 6px 6px;
  justify-content: center; align-items: stretch; animation: rail-in 0.35s ease-out both;
}
.user-tick {
  position: relative; flex: var(--tick-flex, 1) 1 0; min-height: 2px; max-height: var(--tick-slot, 13px); padding: 0; border: 0; background: none;
  display: flex; align-items: center; justify-content: flex-end; cursor: pointer;
}
.tick-bar {
  display: block; height: min(100%, 2px); width: var(--tick-w, 8px); border-radius: var(--radius);
  background: var(--muted-foreground); opacity: var(--tick-op, 0.4); transform-origin: right center;
  transition:
    width 260ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 180ms ease,
    background-color 180ms ease,
    transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
}
.user-tick.hovered .tick-bar {
  background: var(--foreground);
  transform: translateX(-2px);
}
.user-tick.active .tick-bar {
  background: var(--primary);
}
.user-tick:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: var(--radius); }
.rail-card {
  position: absolute; right: 34px; top: 0; width: max-content; min-width: 110px; max-width: 236px;
  display: flex; align-items: baseline; gap: 7px;
  padding: 6px 9px; border-radius: var(--radius);
  background: var(--card); border: 1px solid var(--border); border-left: 2px solid var(--primary);
  box-shadow: var(--shadow); pointer-events: none; opacity: 0;
  transform: translate3d(8px, var(--card-y, 0px), 0) scale(0.95);
  transform-origin: right center;
  transition:
    opacity 160ms ease,
    transform 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
.rail-card.open {
  opacity: 1;
  transform: translate3d(0, var(--card-y, 0px), 0) scale(1);
}
.rail-card.active {
  border-color: color-mix(in srgb, var(--primary) 55%, var(--border));
  border-left-color: var(--primary);
}
.rail-card-idx {
  flex: none; font-size: 11px; font-weight: 600; color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}
.rail-card.active .rail-card-idx {
  color: var(--foreground);
}
.rail-card-body {
  font-size: 12px; line-height: 1.35; color: var(--foreground);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; overflow-wrap: anywhere;
}
@keyframes rail-in { from { opacity: 0; transform: translate(8px, -50%); } to { opacity: 1; transform: translate(0, -50%); } }
.rail-flash { animation: rail-flash 1.4s ease-out; }
@keyframes rail-flash {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--primary) 70%, transparent); }
  30% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--primary) 35%, transparent); }
  100% { box-shadow: 0 0 0 0 transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .user-rail, .rail-flash { animation: none; }
  .tick-bar, .rail-card { transition: none; }
}
@media (max-width: 640px) { .user-rail { display: none; } }
.load-older-bar { display: flex; justify-content: center; padding: 10px 0 4px; }
.load-older-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 12px;
  border-radius: var(--radius);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--muted-foreground);
  background: var(--secondary);
  border: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
}
.load-older-btn:hover:not(:disabled) {
  background: var(--accent);
  color: var(--foreground);
}
.load-older-btn:disabled {
  opacity: 0.6;
  cursor: wait;
}
.queued-dock { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; max-height: 30%; overflow: auto; padding: 8px var(--chat-pad-right, max(24px, calc((100% - 912px) / 2 + var(--gutter-shift, 0px)))) 0 var(--chat-pad-left, max(24px, calc((100% - 912px) / 2 - var(--gutter-shift, 0px)))); }
#log { padding-top: 32px; gap: 26px; }
.agent-report-peer { font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-report-actions { margin-bottom: 8px; }
.agent-report-actions .peer-chip { margin-bottom: 0; }
.chat-notice button:focus-visible,
.load-older-btn:focus-visible,
.peer-chip:focus-visible,
.transcript-jumps button:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
@media (max-width: 760px), (pointer: coarse) {
  #log { padding: 24px 16px 32px; gap: 20px; }
  .queued-dock { padding: 8px 16px 0; }
  .transcript-jumps { right: 16px; bottom: 132px; }
  .transcript-jumps button { width: 44px; height: 44px; }
  .load-older-btn { min-height: 44px; padding: 8px 14px; }
  .peer-chip { min-height: 44px; padding: 8px 12px; }
  .chat-notice button { min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; }
}
.top-sentinel { height: 1px; flex-shrink: 0; pointer-events: none; }
</style>
