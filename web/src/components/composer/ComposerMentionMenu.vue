<script setup lang="ts">
import { ref } from "vue";
import type { MentionCard, MentionGroup } from "./types";

defineProps<{
  mentionGroups: MentionGroup[];
  activeMentionIndex: number;
  errorMessage?: string;
}>();

const emit = defineEmits<{
  (e: "select", card: MentionCard): void;
  (e: "update:activeMentionIndex", index: number): void;
}>();

const menuRef = ref<HTMLElement | null>(null);

function scrollActiveIntoView() {
  const activeEl = menuRef.value?.querySelector<HTMLElement>('[data-mention-active="true"]');
  activeEl?.scrollIntoView({ block: "nearest" });
}

defineExpose({
  $el: menuRef,
  menuRef,
  scrollActiveIntoView,
});
</script>

<template>
  <div
    id="mention-menu"
    ref="menuRef"
    role="listbox"
    aria-label="Board items"
  >
    <div v-if="errorMessage" class="mention-group-header">
      <span>{{ errorMessage }}</span>
    </div>
    <div
      v-for="group in mentionGroups"
      :key="group.status"
      class="mention-group"
      :data-status="group.status"
    >
      <div class="mention-group-header">
        <span class="mention-status-dot" :data-status="group.status" aria-hidden="true"></span>
        <span>{{ group.label }}</span>
      </div>
      <button
        v-for="entry in group.items"
        :key="entry.card.id"
        type="button"
        role="option"
        class="mention-item"
        :class="{ active: entry.flatIndex === activeMentionIndex }"
        :aria-selected="entry.flatIndex === activeMentionIndex ? 'true' : 'false'"
        :data-mention-active="entry.flatIndex === activeMentionIndex ? 'true' : undefined"
        :data-card-id="entry.card.id"
        :data-status="entry.card.status"
        :data-priority="entry.card.priority"
        @mousedown.prevent="emit('select', entry.card)"
        @mouseenter="emit('update:activeMentionIndex', entry.flatIndex)"
      >
        <span
          class="mention-priority-dot"
          :data-priority="entry.card.priority"
          :title="'Priority: ' + entry.card.priority"
          aria-hidden="true"
        ></span>
        <span class="mention-id">#{{ entry.card.id }}</span>
        <span dir="auto" class="mention-subject">{{ entry.card.subject }}</span>
        <span class="mention-priority-label" :data-priority="entry.card.priority">{{ entry.card.priority }}</span>
      </button>
    </div>
  </div>
</template>
