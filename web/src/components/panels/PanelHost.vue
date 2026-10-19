<script setup lang="ts">
import { X } from '@lucide/vue';
import { ui, closePanel } from '@/stores/app';
import { PANELS } from './index';
</script>
<template>
  <div id="panel" v-show="ui.panel" :class="{ open: !!ui.panel, wide: ui.panel === 'board' }" class="fixed inset-0 z-50 flex justify-end bg-black/60" @click.self="closePanel">
    <div role="dialog" aria-modal="true" aria-labelledby="ptitle" aria-describedby="pdesc" tabindex="-1" class="flex h-full w-full flex-col border-l border-border bg-background shadow-xl" :class="ui.panel === 'board' ? 'max-w-6xl' : 'max-w-xl'">
      <header class="flex shrink-0 items-start gap-4 border-b border-border p-5">
        <div class="heading flex-1"><h2 id="ptitle" class="text-base font-semibold">{{ ui.panel ? PANELS[ui.panel]?.title : '' }}</h2><p id="pdesc" class="mt-1 text-xs text-muted-foreground">{{ ui.panel ? PANELS[ui.panel]?.desc : '' }}</p></div>
        <button id="pclose" class="icon-button" aria-label="Close panel" @click="closePanel"><X :size="18" /></button>
      </header>
      <div id="pbody" class="min-h-0 flex-1 overflow-auto p-5"><component :is="PANELS[ui.panel]?.component" v-if="ui.panel && PANELS[ui.panel]" /></div>
    </div>
  </div>
</template>
