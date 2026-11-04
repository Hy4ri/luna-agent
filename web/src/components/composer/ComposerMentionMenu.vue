<script setup lang="ts">
import { computed, ref } from "vue";
import type { MentionCard, MentionGroup } from "./types";
import ComposerMenu from "./ComposerMenu.vue";

defineProps<{ mentionGroups: MentionGroup[]; activeMentionIndex: number; errorMessage?: string }>();
const emit = defineEmits<{
  (e: "select", card: MentionCard): void;
  (e: "update:activeMentionIndex", index: number): void;
}>();

const base = ref<InstanceType<typeof ComposerMenu> | null>(null);
defineExpose({ menuRef: computed(() => base.value?.menuRef ?? null), scrollActiveIntoView: () => base.value?.scrollActiveIntoView() });
</script>

<template>
  <ComposerMenu
    ref="base"
    menu-id="mention-menu"
    label="Board items"
    :groups="mentionGroups"
    :active-index="activeMentionIndex"
    :group-key="g => g.status"
    :entry-key="e => e.card.id"
    :group-attrs="g => ({ 'data-status': g.status })"
    :item-attrs="e => ({ 'data-card-id': e.card.id, 'data-status': e.card.status, 'data-priority': e.card.priority })"
    @select="e => emit('select', e.card)"
    @hover="emit('update:activeMentionIndex', $event)"
  >
    <template #before>
      <div v-if="errorMessage" class="mention-group-header"><span>{{ errorMessage }}</span></div>
    </template>
    <template #header="{ group }">
      <span class="mention-status-dot" :data-status="group.status" aria-hidden="true"></span>
      <span>{{ group.label }}</span>
    </template>
    <template #item="{ entry }">
      <span class="mention-priority-dot" :data-priority="entry.card.priority" :title="'Priority: ' + entry.card.priority" aria-hidden="true"></span>
      <span class="mention-id">#{{ entry.card.id }}</span>
      <span dir="auto" class="mention-subject">{{ entry.card.subject }}</span>
      <span class="mention-priority-label" :data-priority="entry.card.priority">{{ entry.card.priority }}</span>
    </template>
  </ComposerMenu>
</template>
