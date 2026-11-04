<script setup lang="ts">
// Shared listbox for the composer popups (mentions, slash commands, @ sources).
// Wrappers supply the group header, item content and per-item attributes.
import { ref } from "vue";

// Entries differ per menu; wrappers own the concrete types.
type Entry = { flatIndex: number; [key: string]: any };
type Group = { items: Entry[]; [key: string]: any };

defineProps<{
  menuId: string;
  label: string;
  groups: Group[];
  activeIndex: number;
  groupKey: (group: Group) => string;
  entryKey: (entry: Entry) => string | number;
  groupClass?: string;
  groupAttrs?: (group: Group) => Record<string, string>;
  itemClass?: string;
  itemAttrs?: (entry: Entry) => Record<string, string | number>;
}>();

const emit = defineEmits<{
  (e: "select", entry: Entry): void;
  (e: "hover", index: number): void;
}>();

const menuRef = ref<HTMLElement | null>(null);

function scrollActiveIntoView() {
  menuRef.value?.querySelector<HTMLElement>('[data-menu-active="true"]')?.scrollIntoView({ block: "nearest" });
}

defineExpose({ menuRef, scrollActiveIntoView });
</script>

<template>
  <div :id="menuId" ref="menuRef" role="listbox" :aria-label="label">
    <slot name="before" />
    <div v-for="group in groups" :key="groupKey(group)" class="mention-group" :class="groupClass" v-bind="groupAttrs?.(group)">
      <div class="mention-group-header"><slot name="header" :group="group" /></div>
      <button
        v-for="entry in group.items"
        :key="entryKey(entry)"
        type="button"
        role="option"
        class="mention-item"
        :class="[itemClass, { active: entry.flatIndex === activeIndex }]"
        :aria-selected="entry.flatIndex === activeIndex ? 'true' : 'false'"
        :data-menu-active="entry.flatIndex === activeIndex ? 'true' : undefined"
        v-bind="itemAttrs?.(entry)"
        @mousedown.prevent="emit('select', entry)"
        @mouseenter="emit('hover', entry.flatIndex)"
      >
        <slot name="item" :entry="entry" />
      </button>
    </div>
  </div>
</template>
