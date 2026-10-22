<script setup lang="ts">
import { X } from '@lucide/vue';
import { ui, closePanel } from '@/stores/app';
import { computed } from 'vue';
import { PANELS } from './index';

/** Panels that open as a centered floating window instead of a side drawer. */
const WINDOWS: Record<string, string> = { board: 'board-window', projects: 'projects-window' };
const windowClass = computed(() => (ui.panel && WINDOWS[ui.panel]) || '');
</script>
<template>
  <div id="panel" v-show="ui.panel" :class="{ open: !!ui.panel, wide: !!windowClass }" class="panel-backdrop fixed inset-0 z-50 flex justify-end bg-black/60" @click.self="closePanel">
    <div role="dialog" aria-modal="true" aria-labelledby="ptitle" aria-describedby="pdesc" tabindex="-1" class="flex h-full w-full flex-col border-l border-border bg-background shadow-xl" :class="windowClass ? ['float-window', windowClass] : 'max-w-xl'">
      <header class="flex shrink-0 items-start gap-4 border-b border-border p-5">
        <div class="heading flex-1"><h2 id="ptitle" class="text-base font-semibold">{{ ui.panel ? PANELS[ui.panel]?.title : '' }}</h2><p id="pdesc" class="mt-1 text-xs text-muted-foreground">{{ ui.panel ? PANELS[ui.panel]?.desc : '' }}</p></div>
        <button id="pclose" class="icon-button" aria-label="Close panel" @click="closePanel"><X :size="18" /></button>
      </header>
      <div v-if="windowClass" :id="ui.panel === 'board' ? 'board-body' : 'window-body'" class="window-body"><component :is="PANELS[ui.panel!]!.component" /></div>
      <div v-else id="pbody" class="min-h-0 flex-1 overflow-auto p-5"><component :is="PANELS[ui.panel]?.component" v-if="ui.panel && PANELS[ui.panel]" /></div>
    </div>
  </div>
</template>

<style scoped>
.panel-backdrop.wide { align-items: center; justify-content: center; padding: 24px; }
.float-window { width: 100%; max-width: none; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; box-shadow: 0 24px 90px #0009; }
.float-window > header { padding: 16px 20px; }
/* Sized from the backdrop (which fills #app), not the screen: #app starts below the status bar. */
.board-window { height: 94%; max-height: 100%; }
.projects-window { max-width: 900px; height: min(600px, 100%); }
.window-body { flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
@media (max-width: 760px) {
  .panel-backdrop.wide { padding: 8px; }
  .float-window { height: 100%; max-height: 100%; border-radius: var(--radius); }
  .float-window > header { padding: 12px; }
  .board-window:has(.kb-editing) #pdesc { display: none; }
}
</style>
