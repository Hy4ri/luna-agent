<script setup lang="ts">
import { computed } from 'vue';
import { ansiSpans } from '@/lib/tool-view';
const props = defineProps<{ text: string }>();
const spans = computed(() => ansiSpans(props.text.replace(/\n+$/, '')));
</script>
<template>
  <pre class="terminal"><span v-for="(s, i) in spans" :key="i" :class="s.cls || undefined">{{ s.text }}</span><template v-if="!spans.length">No output.</template></pre>
</template>
