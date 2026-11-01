<script setup lang="ts">
import { ref } from "vue";
import type { SlashCommandItem, CommandGroup } from "./types";

defineProps<{
  commandGroups: CommandGroup[];
  activeCommandIndex: number;
}>();

const emit = defineEmits<{
  (e: "select", cmd: SlashCommandItem): void;
  (e: "update:activeCommandIndex", index: number): void;
}>();

const menuRef = ref<HTMLElement | null>(null);

function scrollActiveIntoView() {
  const activeEl = menuRef.value?.querySelector<HTMLElement>('[data-command-active="true"]');
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
    id="command-menu"
    ref="menuRef"
    role="listbox"
    aria-label="Slash commands"
  >
    <div
      v-for="group in commandGroups"
      :key="group.category"
      class="mention-group command-group"
      :data-category="group.category"
    >
      <div class="mention-group-header">
        <span class="command-category-dot" :data-category="group.category" aria-hidden="true"></span>
        <span>{{ group.label }}</span>
      </div>
      <button
        v-for="entry in group.items"
        :key="entry.cmd.id"
        type="button"
        role="option"
        class="mention-item command-item"
        :class="{ active: entry.flatIndex === activeCommandIndex }"
        :aria-selected="entry.flatIndex === activeCommandIndex ? 'true' : 'false'"
        :data-command-active="entry.flatIndex === activeCommandIndex ? 'true' : undefined"
        :data-command="entry.cmd.id"
        :data-category="entry.cmd.category"
        @mousedown.prevent="emit('select', entry.cmd)"
        @mouseenter="emit('update:activeCommandIndex', entry.flatIndex)"
      >
        <span class="command-name">{{ entry.cmd.label }}</span>
        <span v-if="entry.cmd.args" class="command-args">{{ entry.cmd.args }}</span>
        <span class="command-desc">{{ entry.cmd.description }}</span>
      </button>
    </div>
  </div>
</template>
