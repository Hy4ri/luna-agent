<script setup lang="ts">
import { ArrowDown, ArrowUp, ArrowUpDown } from "@lucide/vue"

defineProps<{
  label: string
  active: boolean
  descending: boolean
  align?: "left" | "right"
}>()
defineEmits<{ sort: [] }>()
</script>

<template>
  <th scope="col" class="p-0 text-muted-foreground font-medium" :aria-sort="active ? (descending ? 'descending' : 'ascending') : 'none'">
    <button
      type="button"
      class="sort-heading"
      :class="{ 'sort-heading-right': align === 'right', 'text-foreground': active }"
      :aria-label="active ? `${label}: sort ${descending ? 'ascending' : 'descending'}` : `Sort by ${label}`"
      @click="$emit('sort')"
    >
      {{ label }}
      <component :is="active ? (descending ? ArrowDown : ArrowUp) : ArrowUpDown" :size="13" aria-hidden="true" class="shrink-0" />
    </button>
  </th>
</template>

<style scoped>
.sort-heading { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 44px; padding: 10px; font: inherit; color: inherit; text-align: left; white-space: nowrap; cursor: pointer; }
.sort-heading-right { justify-content: flex-end; }
.sort-heading:hover { background: var(--accent); color: var(--foreground); }
.sort-heading:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
</style>
