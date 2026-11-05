<script setup lang="ts">
import { computed, ref } from "vue";
import type { MentionFeedback, MentionItem } from "@/lib/mention-sources";
import ComposerMenu from "./ComposerMenu.vue";

export type AtGroup = {
  id: string;
  label: string;
  feedback?: MentionFeedback;
  items: { item: MentionItem; flatIndex: number }[];
};

defineProps<{ atGroups: AtGroup[]; activeAtIndex: number }>();
const emit = defineEmits<{
  (e: "select", item: MentionItem): void;
  (e: "update:activeAtIndex", index: number): void;
}>();

const base = ref<InstanceType<typeof ComposerMenu> | null>(null);
defineExpose({ menuRef: computed(() => base.value?.menuRef ?? null), scrollActiveIntoView: () => base.value?.scrollActiveIntoView() });
</script>

<template>
  <ComposerMenu
    ref="base"
    menu-id="at-menu"
    label="Mentions"
    :groups="atGroups"
    :active-index="activeAtIndex"
    :group-key="g => g.id"
    :entry-key="e => e.item.key"
    :group-attrs="g => ({ 'data-source': g.id })"
    :item-attrs="e => ({ 'data-token': e.item.token })"
    @select="e => emit('select', e.item)"
    @hover="emit('update:activeAtIndex', $event)"
  >
    <template #header="{ group }">
      <span>{{ group.label }}</span>
      <span v-if="group.feedback" role="status">{{ group.feedback.message }}</span>
      <button v-if="group.feedback?.retry" type="button" @mousedown.prevent @click="group.feedback.retry()">Retry</button>
    </template>
    <template #item="{ entry }">
      <span dir="auto" class="mention-subject">{{ entry.item.label }}</span>
      <span v-if="entry.item.detail" dir="auto" class="at-detail">{{ entry.item.detail }}</span>
      <span v-if="entry.item.meta" class="at-meta">{{ entry.item.meta }}</span>
    </template>
  </ComposerMenu>
</template>
