<script setup lang="ts">
import { X } from '@lucide/vue';
import { ui, closePanel } from '@/stores/app';
import { PANELS } from './index';
</script>
<template>
  <div id="panel" v-show="ui.panel" :class="{ open: !!ui.panel, wide: ui.panel === 'board' }" class="panel-backdrop fixed inset-0 z-50 flex justify-end bg-black/60" @click.self="closePanel">
    <div role="dialog" aria-modal="true" aria-labelledby="ptitle" aria-describedby="pdesc" tabindex="-1" class="flex h-full w-full flex-col border-l border-border bg-background shadow-xl" :class="ui.panel === 'board' ? 'board-window' : 'max-w-xl'">
      <header class="flex shrink-0 items-start gap-4 border-b border-border p-5">
        <div class="heading flex-1"><h2 id="ptitle" class="text-base font-semibold">{{ ui.panel ? PANELS[ui.panel]?.title : '' }}</h2><p id="pdesc" class="mt-1 text-xs text-muted-foreground">{{ ui.panel ? PANELS[ui.panel]?.desc : '' }}</p></div>
        <button id="pclose" class="icon-button" aria-label="Close panel" @click="closePanel"><X :size="18" /></button>
      </header>
      <div v-if="ui.panel === 'board'" id="board-body"><component :is="PANELS.board!.component" /></div>
      <div v-else id="pbody" class="min-h-0 flex-1 overflow-auto p-5"><component :is="PANELS[ui.panel]?.component" v-if="ui.panel && PANELS[ui.panel]" /></div>
    </div>
  </div>
</template>

<style scoped>
.panel-backdrop.wide { align-items: center; justify-content: center; padding: 24px; }
.board-window { width: 100%; max-width: none; height: 94dvh; max-height: calc(100dvh - 48px); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; box-shadow: 0 24px 90px #0009; }
.board-window > header { padding: 16px 20px; }
#board-body { flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
@media (max-width: 760px) {
  .panel-backdrop.wide { padding: 8px; }
  .board-window { height: calc(100dvh - 16px); max-height: calc(100dvh - 16px); border-radius: 9px; }
  .board-window > header { padding: 12px; }
  .board-window:has(.kb-editing) #pdesc { display: none; }
}
</style>
