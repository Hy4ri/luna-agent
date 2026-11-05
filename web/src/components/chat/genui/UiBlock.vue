<script setup lang="ts">
import { computed, defineAsyncComponent } from "vue";
import Block from "./Block.vue";
import { parseWidget } from "@/lib/widgets/schema";
import { MAX_WIDGETS } from "@/lib/segments";
const ChartWidget = defineAsyncComponent(() => import("./ChartWidget.vue"));
const PlotWidget = defineAsyncComponent(() => import("./PlotWidget.vue"));

const props = defineProps<{ source: string; closed: boolean; excess?: boolean }>();

const parsed = computed(() => {
  if (!props.closed) return null;
  if (props.excess) return { ok: false as const, error: `Not rendered: more than ${MAX_WIDGETS} ui/html blocks in one message.` };
  const r = parseWidget(props.source);
  return r.ok ? r : { ok: false as const, error: `Widget invalid: ${r.error}` };
});
</script>

<template>
  <Block :source="source" label="Widget" :building="closed ? undefined : 'Building widget…'" :error="parsed && !parsed.ok ? parsed.error : ''">
    <template v-if="parsed?.ok">
      <ChartWidget v-if="parsed.widget.type === 'chart'" :widget="parsed.widget" />
      <PlotWidget v-else :widget="parsed.widget" />
    </template>
  </Block>
</template>
