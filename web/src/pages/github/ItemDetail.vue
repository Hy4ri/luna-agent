<script setup lang="ts">
import StatusIcon from "./StatusIcon.vue";
import type { RepoInfo, Detail } from "../../../../src/github";
import Markdown from "@/components/chat/Markdown.vue";
import BoardLink from "./BoardLink.vue";
import ItemActions from "./ItemActions.vue";
import { ExternalLink, MessageSquare, CheckCircle2, XCircle, Clock } from "@lucide/vue";

defineProps<{
  repo: string;
  detail: Detail | null;
  info: RepoInfo | null;
  loading: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  (e: "changed", detail?: Detail): void;
  (e: "deleted"): void;
}>();

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}
</script>

<template>
  <div class="flex flex-col h-full overflow-y-auto bg-card/30 p-6 text-foreground">
    <div v-if="loading && !detail" class="text-center text-muted-foreground text-sm py-12">
      Loading detail…
    </div>
    <div v-else-if="error" class="text-center text-destructive text-sm py-12">
      {{ error }}
    </div>
    <div v-else-if="!detail" class="text-center text-muted-foreground text-sm py-12">
      Select an item to view details.
    </div>
    <div v-else class="space-y-6 max-w-4xl mx-auto w-full">
      <BoardLink :repo="repo" :number="detail.number" />
      <!-- Header -->
      <div class="space-y-2 border-b border-border/40 pb-4">
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <StatusIcon :kind="detail.kind" :state="detail.state" :draft="detail.pr?.draft" />
          <span class="uppercase tracking-wide font-medium">{{ detail.kind === 'pr' ? 'Pull Request' : 'Issue' }}</span>
          <span>#{{ detail.number }}</span>
          <span v-if="detail.state === 'MERGED'" class="text-purple-400 font-medium ml-2">Merged</span>
          <span v-else-if="detail.state === 'CLOSED'" class="text-destructive font-medium ml-2">Closed</span>
          <span v-else class="text-green-400 font-medium ml-2">Open</span>

          <a
            :href="detail.url"
            target="_blank"
            rel="noopener noreferrer"
            class="ml-auto inline-flex items-center gap-1 text-primary hover:underline"
          >
            <span>Open on GitHub</span>
            <ExternalLink class="w-3.5 h-3.5" />
          </a>
        </div>
        <h1 class="text-xl font-semibold">{{ detail.title }}</h1>
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <span v-if="detail.author">@{{ detail.author }}</span>
          <span>opened on {{ formatTime(detail.createdAt) }}</span>
        </div>
      </div>

      <!-- PR specific info -->
      <div v-if="detail.pr" class="bg-card border border-border rounded-lg p-4 space-y-3 text-xs">
        <div class="flex items-center gap-3 font-mono">
          <span class="px-2 py-1 bg-muted rounded text-primary">{{ detail.pr.head }}</span>
          <span class="text-muted-foreground">→</span>
          <span class="px-2 py-1 bg-muted rounded text-primary">{{ detail.pr.base }}</span>
          <span class="ml-auto text-muted-foreground">+{{ detail.pr.additions }} / -{{ detail.pr.deletions }} ({{ detail.pr.files }} files)</span>
        </div>
        <div class="flex items-center gap-4 pt-2 border-t border-border/40 text-muted-foreground">
          <span>Mergeable: <strong class="text-foreground">{{ detail.pr.mergeable }}</strong></span>
          <span>Review: <strong class="text-foreground">{{ detail.pr.review ?? 'NONE' }}</strong></span>
          <span>Checks: <strong class="text-foreground">{{ detail.pr.checkState ?? 'NONE' }}</strong></span>
        </div>
        <div v-if="detail.pr.checks.length > 0" class="pt-2 border-t border-border/40 space-y-1">
          <div v-for="chk in detail.pr.checks" :key="chk.name" class="flex items-center gap-2">
            <CheckCircle2 v-if="chk.state === 'SUCCESS'" class="w-3.5 h-3.5 text-green-400 shrink-0" />
            <XCircle v-else-if="chk.state === 'FAILURE' || chk.state === 'ERROR'" class="w-3.5 h-3.5 text-destructive shrink-0" />
            <Clock v-else class="w-3.5 h-3.5 text-yellow-400 shrink-0" />
            <span class="truncate">{{ chk.name }}</span>
            <a v-if="chk.url" :href="chk.url" target="_blank" class="ml-auto text-primary hover:underline">Details</a>
          </div>
        </div>
      </div>

      <!-- Body -->
      <div class="bg-card border border-border rounded-lg p-5">
        <Markdown :content="detail.body || '*No description provided.*'" />
      </div>

      <!-- Comments -->
      <div class="space-y-4 pt-4">
        <h3 class="text-sm font-medium flex items-center gap-2">
          <MessageSquare class="w-4 h-4" />
          <span>Comments ({{ detail.commentTotal }})</span>
        </h3>
        <div v-for="c in detail.comments" :key="c.id" class="bg-card border border-border rounded-lg p-4 space-y-2 text-sm">
          <div class="flex items-center gap-2 text-xs text-muted-foreground border-b border-border/40 pb-2">
            <span class="font-medium text-foreground">@{{ c.author ?? 'ghost' }}</span>
            <span>commented on {{ formatTime(c.createdAt) }}</span>
            <a :href="c.url" target="_blank" class="ml-auto text-primary hover:underline flex items-center gap-1">
              <span>View</span>
              <ExternalLink class="w-3 h-3" />
            </a>
          </div>
          <Markdown :content="c.body" />
        </div>
        <div v-if="detail.commentTotal > detail.comments.length" class="text-xs text-muted-foreground text-center py-2">
          {{ detail.commentTotal - detail.comments.length }} more comments on GitHub.
        </div>
      </div>

      <!-- Actions & Reply -->
      <ItemActions
        v-if="info"
        :repo="repo"
        :detail="detail"
        :info="info"
        @changed="detailParam => emit('changed', detailParam)"
        @deleted="emit('deleted')"
      />
    </div>
  </div>
</template>
