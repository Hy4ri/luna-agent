<script setup lang="ts">
import StatusIcon from "./StatusIcon.vue";
import type { ListItem } from "../../../../src/github";
import { MessageSquare, CircleCheck, CircleX, AlertCircle } from "@lucide/vue";

defineProps<{
  items: ListItem[];
  selectedNumber: number | null;
  loading: boolean;
  hasNext: boolean;
  loadingMore: boolean;
}>();

defineEmits<{
  (e: "select", item: ListItem): void;
  (e: "loadMore"): void;
}>();

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
  <div class="flex flex-col h-full overflow-y-auto divide-y divide-border/40 text-foreground">
    <div v-if="loading && items.length === 0" class="p-8 text-center text-muted-foreground text-sm">
      Loading items…
    </div>
    <div v-else-if="items.length === 0" class="p-8 text-center text-muted-foreground text-sm">
      No items found.
    </div>
    <button
      v-for="item in items"
      :key="item.number"
      type="button"
      @click="$emit('select', item)"
      class="flex items-start gap-3 p-3 text-left hover:bg-accent/60 transition-colors w-full relative"
      :class="{ 'bg-accent/80': selectedNumber === item.number }"
    >
      <div class="mt-0.5 shrink-0">
        <StatusIcon :kind="item.kind" :state="item.state" :draft="item.draft" />
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-medium text-sm truncate">{{ item.title }}</span>
          <span class="text-xs text-muted-foreground shrink-0">#{{ item.number }}</span>
        </div>
        <div class="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
          <span v-if="item.state === 'MERGED'" class="text-purple-400 font-medium">Merged</span>
          <span v-else-if="item.state === 'CLOSED'" class="text-destructive font-medium">Closed</span>
          <span v-else class="text-green-400 font-medium">Open</span>

          <span v-if="item.draft" class="px-1.5 py-0.5 bg-card text-muted-foreground rounded text-[10px]">Draft</span>

          <span v-for="l in item.labels" :key="l.name" class="inline-flex items-center gap-1">
            <span class="w-2 h-2 rounded-full" :style="{ backgroundColor: `#${l.color}` }" />
            <span>{{ l.name }}</span>
          </span>

          <span v-if="item.author">@{{ item.author }}</span>
          <span>{{ formatTime(item.updatedAt) }}</span>

          <div v-if="item.kind === 'pr'" class="flex items-center gap-1 ml-auto">
            <CircleCheck v-if="item.checks === 'SUCCESS'" class="w-3.5 h-3.5 text-green-400" title="Checks passed" />
            <CircleX v-else-if="item.checks === 'FAILURE' || item.checks === 'ERROR'" class="w-3.5 h-3.5 text-destructive" title="Checks failed" />
            <AlertCircle v-else-if="item.checks === 'PENDING'" class="w-3.5 h-3.5 text-yellow-400" title="Checks pending" />
          </div>
        </div>
      </div>
      <div v-if="item.comments > 0" class="flex items-center gap-1 text-xs text-muted-foreground shrink-0 self-center">
        <MessageSquare class="w-3.5 h-3.5" />
        <span>{{ item.comments }}</span>
      </div>
    </button>

    <div v-if="hasNext" class="p-3 text-center">
      <button
        type="button"
        @click="$emit('loadMore')"
        :disabled="loadingMore"
        class="px-3 py-1.5 text-xs bg-card hover:bg-accent rounded border border-border disabled:opacity-50"
      >
        {{ loadingMore ? 'Loading…' : 'Load more' }}
      </button>
    </div>
  </div>
</template>
