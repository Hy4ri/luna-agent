<script setup lang="ts">
import { computed, ref } from "vue";
import type { SlashCommandItem, CommandGroup } from "./types";
import ComposerMenu from "./ComposerMenu.vue";

defineProps<{ commandGroups: CommandGroup[]; activeCommandIndex: number }>();
const emit = defineEmits<{
  (e: "select", cmd: SlashCommandItem): void;
  (e: "update:activeCommandIndex", index: number): void;
}>();

const base = ref<InstanceType<typeof ComposerMenu> | null>(null);
defineExpose({ menuRef: computed(() => base.value?.menuRef ?? null), scrollActiveIntoView: () => base.value?.scrollActiveIntoView() });
</script>

<template>
  <ComposerMenu
    ref="base"
    menu-id="command-menu"
    label="Slash commands"
    :groups="commandGroups"
    :active-index="activeCommandIndex"
    :group-key="g => g.category"
    :entry-key="e => e.cmd.id"
    group-class="command-group"
    item-class="command-item"
    :group-attrs="g => ({ 'data-category': g.category })"
    :item-attrs="e => ({ 'data-command': e.cmd.id, 'data-category': e.cmd.category })"
    @select="e => emit('select', e.cmd)"
    @hover="emit('update:activeCommandIndex', $event)"
  >
    <template #header="{ group }">
      <span class="command-category-dot" :data-category="group.category" aria-hidden="true"></span>
      <span>{{ group.label }}</span>
    </template>
    <template #item="{ entry }">
      <span class="command-name">{{ entry.cmd.label }}</span>
      <span v-if="entry.cmd.args" class="command-args">{{ entry.cmd.args }}</span>
      <span class="command-desc">{{ entry.cmd.description }}</span>
    </template>
  </ComposerMenu>
</template>
