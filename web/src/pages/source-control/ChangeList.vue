<script setup lang="ts">
import { computed } from 'vue';
import { FilePlus, FileText, AlertTriangle, Plus, Minus } from '@lucide/vue';
import type { ChangeFile } from './client';
const props=defineProps<{files:ChangeFile[];selectedPath:string|null;selectedStaged:boolean;disabled:boolean}>();
const emit=defineEmits<{select:[path:string,staged:boolean];stage:[paths:string[]];unstage:[paths:string[]]}>();
const groups=computed(()=>[
  {name:'Conflicts',staged:false,files:props.files.filter(f=>f.conflict),action:null},
  {name:'Staged',staged:true,files:props.files.filter(f=>f.staged&&!f.conflict),action:'unstage' as const},
  {name:'Changes',staged:false,files:props.files.filter(f=>!f.untracked&&!f.conflict&&f.worktree!=='.'),action:'stage' as const},
  {name:'Untracked',staged:false,files:props.files.filter(f=>f.untracked),action:'stage' as const},
]);
function act(action:'stage'|'unstage',files:ChangeFile[]){const paths=files.map(f=>f.path);if(action==='stage')emit('stage',paths);else emit('unstage',paths);}
</script>
<template>
  <div class="h-full overflow-auto text-xs">
    <section v-for="group in groups" :key="group.name" class="p-2 border-b border-border">
      <header class="flex items-center justify-between gap-2 pb-1 text-muted-foreground">
        <h2 class="font-medium">{{group.name}} ({{group.files.length}})</h2>
        <button v-if="group.action&&group.files.length" type="button" :disabled="disabled" class="underline disabled:opacity-50" @click="act(group.action,group.files)">{{group.action==='stage'?'Stage all':'Unstage all'}}</button>
      </header>
      <p v-if="!group.files.length" class="px-2 py-1 text-muted-foreground">No {{group.name.toLowerCase()}} files</p>
      <div v-for="file in group.files" :key="file.path" class="flex items-center rounded" :class="selectedPath===file.path&&selectedStaged===group.staged?'bg-accent':''">
        <button type="button" class="flex flex-1 min-w-0 items-center gap-1.5 px-2 py-1.5 text-left hover:bg-muted" :aria-label="`View ${group.staged?'staged':'working'} diff ${file.path}`" @click="emit('select',file.path,group.staged)">
          <component :is="file.conflict?AlertTriangle:file.untracked?FilePlus:FileText" :size="14" class="shrink-0"/>
          <span class="truncate" :title="file.path">{{file.path}}</span>
        </button>
        <button v-if="group.action" type="button" :disabled="disabled" :aria-label="`${group.action==='stage'?'Stage':'Unstage'} ${file.path}`" class="p-2 hover:bg-muted disabled:opacity-50" @click="act(group.action,[file])"><component :is="group.action==='stage'?Plus:Minus" :size="14"/></button>
      </div>
    </section>
  </div>
</template>
