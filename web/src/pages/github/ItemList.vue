<script setup lang="ts">
import { computed, onUnmounted, watch } from "vue";
import { useVirtualList } from "@vueuse/core";
import StatusIcon from "./StatusIcon.vue";
import type { ListItem } from "../../../../src/github";
import { MessageSquare, CircleCheck, CircleX, AlertCircle } from "@lucide/vue";

const props = defineProps<{
  items: ListItem[];
  selectedNumber: number | null;
  loading: boolean;
  hasNext: boolean;
  loadingMore: boolean;
  /** Shown in the empty state so it can offer the next useful action. */
  emptyHint?: string;
}>();

const { list: vItems, containerProps, wrapperProps } = useVirtualList(computed(() => props.items), { itemHeight: 72, overscan: 8 });
const emit = defineEmits<{
  (e: "select", item: ListItem): void;
  (e: "loadMore"): void;
  (e: "prefetch", item: ListItem): void;
  (e: "emptyAction"): void;
}>();
/** Arrow keys and j/k move focus between rows; the virtual list renders the rows near the viewport. */
function onKeydown(e: KeyboardEvent) {
  const key = e.key === "j" ? "ArrowDown" : e.key === "k" ? "ArrowUp" : e.key;
  if ((key !== "ArrowDown" && key !== "ArrowUp") || e.ctrlKey || e.metaKey || e.altKey) return;
  const rows = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button[data-row]")];
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = rows[at < 0 ? (key === "ArrowDown" ? 0 : rows.length - 1) : at + (key === "ArrowDown" ? 1 : -1)];
  if (!next) return;
  e.preventDefault(); next.focus(); next.scrollIntoView({ block: "nearest" });
}

let hoverTimer: ReturnType<typeof setTimeout> | undefined;
function cancelPrefetch() { clearTimeout(hoverTimer); hoverTimer = undefined; }
function schedulePrefetch(item: ListItem, keyboard = false) {
  cancelPrefetch();
  if (!keyboard && !window.matchMedia('(hover: hover)').matches) return;
  hoverTimer = setTimeout(() => { hoverTimer = undefined; emit('prefetch', item); }, 150);
}
watch(() => props.items, cancelPrefetch);
onUnmounted(cancelPrefetch);
function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return d.toISOString().slice(0, 10);
}
</script>

<template>
  <div class="flex flex-col h-full overflow-y-auto divide-y divide-border/40 text-foreground" v-bind="containerProps" @keydown="onKeydown">
    <div v-if="loading && items.length === 0" class="p-8 text-center text-muted-foreground text-sm">
      Loading items…
    </div>
    <div v-else-if="items.length === 0" class="p-8 text-center text-muted-foreground text-sm">
      <p>No items found.</p>
      <button v-if="emptyHint" type="button" class="mt-2 px-3 py-1.5 text-xs bg-card hover:bg-accent rounded-[var(--radius)] border border-border max-[760px]:min-h-11" @click="$emit('emptyAction')">{{ emptyHint }}</button>
    </div>
    <div v-bind="wrapperProps"><button
      v-for="{ data: item } in vItems"
      :key="item.number"
      type="button"
      data-row
      :aria-current="selectedNumber === item.number ? 'true' : undefined"
      @click="$emit('select', item)"
      @pointerenter="schedulePrefetch(item)" @pointerleave="cancelPrefetch"
      @focus="schedulePrefetch(item, true)" @blur="cancelPrefetch"
      class="flex items-start gap-3 p-3 text-left hover:bg-accent/60 transition-colors w-full relative focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px]"
      :class="{ 'bg-accent/80': selectedNumber === item.number }"
    >
      <div class="mt-0.5 shrink-0">
        <StatusIcon :kind="item.kind" :state="item.state" :draft="item.draft" />
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-medium text-sm truncate">{{ item.title }}</span>
          <span class="text-xs text-muted-foreground shrink-0 tabular-nums">#{{ item.number }}</span>
        </div>
        <div class="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
          <span v-if="item.state === 'MERGED'" class="text-[var(--primary-text)] font-medium">Merged</span>
          <span v-else-if="item.state === 'CLOSED'" class="text-destructive font-medium">Closed</span>
          <span v-else class="text-[var(--ok)] font-medium">Open</span>

          <span v-if="item.draft" class="px-1.5 py-0.5 bg-card text-muted-foreground rounded-[var(--radius)] text-[10px]">Draft</span>

          <span v-for="l in item.labels" :key="l.name" class="inline-flex items-center gap-1">
            <span class="w-2 h-2 rounded-full" :style="{ backgroundColor: `#${l.color}` }" />
            <span>{{ l.name }}</span>
          </span>

          <span v-if="item.author">@{{ item.author }}</span>
          <span>{{ formatTime(item.updatedAt) }}</span>

          <div v-if="item.kind === 'pr'" class="flex items-center gap-1 ml-auto">
            <span v-if="item.review === 'APPROVED'" class="text-[10px] text-[var(--ok)]">Approved</span>
            <span v-else-if="item.review === 'CHANGES_REQUESTED'" class="text-[10px] text-destructive">Changes requested</span>
            <CircleCheck v-if="item.checks === 'SUCCESS'" class="w-3.5 h-3.5 text-[var(--ok)]" title="Checks passed" />
            <CircleX v-else-if="item.checks === 'FAILURE' || item.checks === 'ERROR'" class="w-3.5 h-3.5 text-destructive" title="Checks failed" />
            <AlertCircle v-else-if="item.checks === 'PENDING'" class="w-3.5 h-3.5 text-[var(--warn)]" title="Checks pending" />
          </div>
        </div>
      </div>
      <div v-if="item.comments > 0" class="flex items-center gap-1 text-xs text-muted-foreground shrink-0 self-center tabular-nums">
        <MessageSquare class="w-3.5 h-3.5" />
        <span>{{ item.comments }}</span>
      </div>
    </button></div>

    <div v-if="hasNext" class="p-3 text-center">
      <button
        type="button"
        @click="$emit('loadMore')"
        :disabled="loadingMore"
        class="px-3 py-1.5 text-xs bg-card hover:bg-accent rounded-[var(--radius)] border border-border disabled:opacity-50 max-[760px]:min-h-11"
      >
        {{ loadingMore ? 'Loading…' : 'Load more' }}
      </button>
    </div>
  </div>
</template>
