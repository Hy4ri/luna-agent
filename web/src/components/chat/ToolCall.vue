<script setup lang="ts">
import { computed } from 'vue';
import { chat, toolArgsText, openSession } from '@/stores/chat';
const props = defineProps<{ id: string; name: string; args?: unknown; result?: any }>();
const output = computed(() => props.id in chat.toolLive ? chat.toolLive[props.id] : (typeof props.result?.content === 'string' ? props.result.content : (props.result?.content || []).map((b: any) => b.text || '').join('')));
const child = computed(() => /spawned child (\d+)/.exec(output.value)?.[1]);
</script>
<template>
  <details class="tool" :data-call="id" :open="chat.activeTools.has(id) || undefined">
    <summary>{{ chat.activeTools.has(id) ? 'Running · ' : result?.isError ? 'Failed · ' : 'Tool · ' }}{{ name }}<a v-if="child" href="#" @click.prevent.stop="openSession(child)"> → child {{ child }}</a></summary>
    <pre>{{ toolArgsText(args) }}{{ output }}</pre>
    <template v-for="(block,i) in (Array.isArray(result?.content) ? result.content : [])" :key="i">
      <img v-if="block.type === 'image' && ['image/png','image/jpeg','image/webp','image/gif'].includes(block.mimeType) && typeof block.data === 'string'" class="tool-image" :src="`data:${block.mimeType};base64,${block.data}`" :alt="name + ' result'" />
    </template>
  </details>
</template>
