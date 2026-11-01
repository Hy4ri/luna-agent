<script setup lang="ts">
import { ref } from "vue";
import type { MentionItem } from "@/lib/mention-sources";

export type AtGroup = {
  id: string;
  label: string;
  items: { item: MentionItem; flatIndex: number }[];
};

defineProps<{
  atGroups: AtGroup[];
  activeAtIndex: number;
}>();

const emit = defineEmits<{
  (e: "select", item: MentionItem): void;
  (e: "update:activeAtIndex", index: number): void;
}>();

const menuRef = ref<HTMLElement | null>(null);

function scrollActiveIntoView() {
  const activeEl = menuRef.value?.querySelector<HTMLElement>('[data-at-active="true"]');
  activeEl?.scrollIntoView({ block: "nearest" });
}

defineExpose({
  $el: menuRef,
  menuRef,
  scrollActiveIntoView,
});
</script>

<template>
  <div id="at-menu" ref="menuRef" role="listbox" aria-label="Mentions">
    <div v-for="group in atGroups" :key="group.id" class="mention-group" :data-source="group.id">
      <div class="mention-group-header"><span>{{ group.label }}</span></div>
      <button
        v-for="entry in group.items"
        :key="entry.item.key"
        type="button"
        role="option"
        class="mention-item"
        :class="{ active: entry.flatIndex === activeAtIndex }"
        :aria-selected="entry.flatIndex === activeAtIndex ? 'true' : 'false'"
        :data-at-active="entry.flatIndex === activeAtIndex ? 'true' : undefined"
        :data-token="entry.item.token"
        @mousedown.prevent="emit('select', entry.item)"
        @mouseenter="emit('update:activeAtIndex', entry.flatIndex)"
      >
        <span dir="auto" class="mention-subject">{{ entry.item.label }}</span>
        <span dir="auto" v-if="entry.item.detail" class="at-detail">{{ entry.item.detail }}</span>
        <span v-if="entry.item.meta" class="at-meta">{{ entry.item.meta }}</span>
      </button>
    </div>
  </div>
</template>
