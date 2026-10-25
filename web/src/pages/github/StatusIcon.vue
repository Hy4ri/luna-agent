<script setup lang="ts">
import { computed } from 'vue';
import { GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, GitMerge, CircleDot, CircleCheck } from '@lucide/vue';
const props = defineProps<{ kind: 'pr' | 'issue'; state: string; draft?: boolean }>();
const status = computed(() => {
  if (props.kind === 'issue') return props.state === 'CLOSED'
    ? { icon: CircleCheck, color: 'text-purple-400', label: 'Closed issue' }
    : { icon: CircleDot, color: 'text-green-400', label: 'Open issue' };
  if (props.state === 'MERGED') return { icon: GitMerge, color: 'text-purple-400', label: 'Merged pull request' };
  if (props.state === 'CLOSED') return { icon: GitPullRequestClosed, color: 'text-red-400', label: 'Closed pull request' };
  if (props.draft) return { icon: GitPullRequestDraft, color: 'text-muted-foreground', label: 'Draft pull request' };
  return { icon: GitPullRequest, color: 'text-green-400', label: 'Open pull request' };
});
</script>

<template>
  <component :is="status.icon" class="w-4 h-4 shrink-0" :class="status.color" role="img" :aria-label="status.label" />
</template>
