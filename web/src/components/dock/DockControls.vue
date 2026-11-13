<script setup lang="ts">
// Right end of every dock bar: pane switch (when more than one pane exists), side/bottom toggle, hide.
import { computed } from "vue";
import { ChevronDown, Globe, Mail, PanelBottom, PanelRight, SquareTerminal } from "@lucide/vue";
import { dock, effectivePosition, setPosition, type DockPane } from "@/stores/dock";
import { terminal } from "@/stores/terminal";

defineProps<{ panes?: DockPane[] }>();
const emit = defineEmits<{ pane: [pane: DockPane] }>();
// The toggle is disabled while the chat area is too narrow: the dock is at the bottom whatever the saved choice says.
const forced = computed(() => effectivePosition("right", dock.area) === "bottom");
const side = computed(() => !forced.value && dock.position === "right");
const toggle = () => setPosition(dock.position === "right" ? "bottom" : "right");
</script>

<template>
  <div class="dock-controls">
    <div v-if="panes && panes.length > 1" class="dock-panes" role="group" aria-label="Dock pane">
      <button v-for="p in panes" :key="p" type="button" class="icon-button" :class="{ 'text-primary-text': dock.pane === p }" :aria-pressed="dock.pane === p" :aria-label="p === 'terminal' ? 'Terminal' : p === 'browser' ? 'Browser' : 'Mail'" :title="p === 'terminal' ? 'Terminal' : p === 'browser' ? 'Browser' : 'Mail'" @click="emit('pane', p)">
        <SquareTerminal v-if="p === 'terminal'" :size="14" /><Globe v-else-if="p === 'browser'" :size="14" /><Mail v-else :size="14" />
      </button>
    </div>
    <button type="button" class="icon-button" :aria-pressed="side" :disabled="forced" :aria-label="side ? 'Move dock to the bottom' : 'Move dock to the side'" :title="forced ? 'Too narrow for a side dock' : side ? 'Move dock to the bottom' : 'Move dock to the side'" @click="toggle">
      <PanelBottom v-if="side" :size="14" /><PanelRight v-else :size="14" />
    </button>
    <button type="button" class="icon-button" aria-label="Hide dock" title="Hide dock (terminals keep running)" @click="terminal.open = false"><ChevronDown :size="14" /></button>
  </div>
</template>

<style scoped>
.dock-controls { display: flex; align-items: center; gap: 2px; }
.dock-panes { display: flex; gap: 2px; margin-right: 4px; padding-right: 4px; border-right: 1px solid var(--border); }
@media (max-width: 760px), (pointer: coarse) {
  .dock-controls .icon-button { width: 44px; height: 44px; }
}
</style>
