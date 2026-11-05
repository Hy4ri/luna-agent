<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { parseDiff, splitRows, diffMode, type DiffLine } from "@/lib/diff";

/** id: the shown file. A refresh of the same file keeps "Show more" expanded. */
const props = defineProps<{ text: string; id: string; truncated?: boolean }>();
/** Rows drawn before "Show more": a 20,000-line diff would freeze the page. */
const PAGE = 2000;
const limit = ref(PAGE);
watch(() => props.id, () => { limit.value = PAGE; });

const root = ref<HTMLElement | null>(null), width = ref(0);
let observer: ResizeObserver | null = null;
onMounted(() => { observer = new ResizeObserver(([entry]) => { width.value = entry?.contentRect.width ?? 0; }); if (root.value) observer.observe(root.value); });
onUnmounted(() => observer?.disconnect());
/** Side-by-side needs room for two code columns; narrow screens always get unified. */
const canSplit = computed(() => width.value >= 720);
const split = computed(() => canSplit.value && diffMode.value === "split");

const lines = computed(() => parseDiff(props.text));
const rows = computed(() => split.value ? splitRows(lines.value) : lines.value);
const additions = computed(() => lines.value.filter(l => l.kind === "add").length);
const deletions = computed(() => lines.value.filter(l => l.kind === "del").length);

function tone(kind: string | undefined) {
  return kind === "add" ? "bg-emerald-500/10" : kind === "del" ? "bg-rose-500/10" : "";
}
function sign(kind: DiffLine["kind"]) { return kind === "add" ? "+" : kind === "del" ? "-" : " "; }
</script>

<template>
  <div ref="root" class="flex flex-col h-full min-h-0 font-mono text-xs">
    <div class="flex items-center gap-3 px-2 py-1 border-b border-border bg-card font-sans text-[11px] text-muted-foreground shrink-0">
      <span><span class="text-emerald-400">+{{ additions }}</span> <span class="text-rose-400">-{{ deletions }}</span></span>
      <span v-if="truncated" class="text-amber-500">Diff truncated at the size limit.</span>
      <div v-if="canSplit" role="group" aria-label="Diff layout" class="ml-auto flex rounded border border-border overflow-hidden">
        <button type="button" class="px-2 py-0.5" :class="diffMode === 'unified' ? 'bg-secondary text-foreground' : ''" :aria-pressed="diffMode === 'unified'" @click="diffMode = 'unified'">Unified</button>
        <button type="button" class="px-2 py-0.5 border-l border-border" :class="diffMode === 'split' ? 'bg-secondary text-foreground' : ''" :aria-pressed="diffMode === 'split'" @click="diffMode = 'split'">Split</button>
      </div>
    </div>
    <div class="flex-1 min-h-0 overflow-auto">
      <table class="w-full border-collapse leading-5">
        <tbody v-if="!split">
          <tr v-for="(line, idx) in (rows as DiffLine[]).slice(0, limit)" :key="idx" class="vl-row" :class="tone(line.kind)">
            <template v-if="line.kind === 'hunk' || line.kind === 'meta'">
              <td colspan="3" class="px-2 whitespace-pre" :class="line.kind === 'hunk' ? 'bg-sky-500/10 text-sky-400' : 'text-muted-foreground'">{{ line.text }}</td>
            </template>
            <template v-else>
              <td class="w-px px-1.5 text-right select-none text-muted-foreground/70 align-top">{{ line.old ?? '' }}</td>
              <td class="w-px px-1.5 text-right select-none text-muted-foreground/70 align-top border-r border-border">{{ line.new ?? '' }}</td>
              <td class="px-2 whitespace-pre"><span class="select-none" :class="line.kind === 'add' ? 'text-emerald-400' : line.kind === 'del' ? 'text-rose-400' : 'text-muted-foreground'">{{ sign(line.kind) }}</span>{{ line.text }}</td>
            </template>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="(row, idx) in (rows as ReturnType<typeof splitRows>).slice(0, limit)" :key="idx" class="vl-row">
            <template v-if="row.kind !== 'pair'">
              <td colspan="4" class="px-2 whitespace-pre" :class="row.kind === 'hunk' ? 'bg-sky-500/10 text-sky-400' : 'text-muted-foreground'">{{ row.text }}</td>
            </template>
            <template v-else>
              <td class="w-px px-1.5 text-right select-none text-muted-foreground/70 align-top" :class="tone(row.left?.kind === 'ctx' ? undefined : row.left?.kind)">{{ row.left?.old ?? '' }}</td>
              <td class="w-1/2 px-2 whitespace-pre-wrap break-all align-top border-r border-border" :class="row.left ? tone(row.left.kind === 'ctx' ? undefined : row.left.kind) : 'bg-muted/30'">{{ row.left?.text ?? '' }}</td>
              <td class="w-px px-1.5 text-right select-none text-muted-foreground/70 align-top" :class="tone(row.right?.kind === 'ctx' ? undefined : row.right?.kind)">{{ row.right?.new ?? '' }}</td>
              <td class="w-1/2 px-2 whitespace-pre-wrap break-all align-top" :class="row.right ? tone(row.right.kind === 'ctx' ? undefined : row.right.kind) : 'bg-muted/30'">{{ row.right?.text ?? '' }}</td>
            </template>
          </tr>
        </tbody>
      </table>
      <button v-if="rows.length > limit" type="button" class="m-2 px-2 py-1 underline text-muted-foreground font-sans" @click="limit += PAGE * 5">Show more ({{ rows.length - limit }} lines left)</button>
    </div>
  </div>
</template>
