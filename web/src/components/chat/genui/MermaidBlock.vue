<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { Maximize2 } from "@lucide/vue";
import Block from "./Block.vue";
import { sanitizeSvg, scrubCssom } from "@/lib/genui/sanitize";
import { font, readTheme } from "@/lib/genui/theme";
import { openImage } from "@/stores/image-viewer";

const props = defineProps<{ source: string; closed: boolean }>();
const host = ref<HTMLElement>();
const error = ref("");
const rendered = ref(false);
let svgText = "";
let imageUrl = "";
let run = 0;

let mermaidModule: Promise<typeof import("mermaid").default> | null = null;
const loadMermaid = () => (mermaidModule ??= import("mermaid").then(m => m.default));

async function render() {
  const id = ++run;
  if (!props.closed || !host.value) return;
  try {
    const mermaid = await loadMermaid();
    const t = readTheme();
    // Mermaid needs literal colors, so the live theme is read on every render.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: font(),
      themeVariables: {
        darkMode: true,
        background: t.background,
        fontFamily: font(),
        primaryColor: t.secondary,
        primaryTextColor: t.foreground,
        primaryBorderColor: t["chart-1"],
        secondaryColor: t.card,
        secondaryTextColor: t.foreground,
        secondaryBorderColor: t["chart-2"],
        tertiaryColor: t.card,
        tertiaryTextColor: t.foreground,
        tertiaryBorderColor: t.border,
        lineColor: t["muted-foreground"],
        textColor: t.foreground,
        mainBkg: t.secondary,
        nodeBorder: t["chart-1"],
        clusterBkg: t.card,
        clusterBorder: t.border,
        titleColor: t.foreground,
        edgeLabelBackground: t.card,
        noteBkgColor: t.card,
        noteTextColor: t.foreground,
        noteBorderColor: t.border,
        actorBkg: t.secondary,
        actorBorder: t["chart-1"],
        actorTextColor: t.foreground,
        signalColor: t["muted-foreground"],
        signalTextColor: t.foreground,
        ...Object.fromEntries([1, 2, 3, 4, 5, 6].flatMap(i => [[`pie${i}`, t[`chart-${i}` as "chart-1"]], [`cScale${i - 1}`, t[`chart-${i}` as "chart-1"]]])),
        pieStrokeColor: t.background,
        pieOuterStrokeColor: t.border,
        pieTitleTextColor: t.foreground,
        pieSectionTextColor: t.background,
        pieLegendTextColor: t.foreground,
      },
    });
    await mermaid.parse(props.source);
    const { svg } = await mermaid.render(`luna-mermaid-${Math.random().toString(36).slice(2)}`, props.source);
    if (id !== run || !host.value) return;
    const fragment = sanitizeSvg(svg);
    const root = host.value.shadowRoot ?? host.value.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ":host{display:block}svg{display:block;max-width:100%;height:auto;margin:0 auto}";
    root.replaceChildren(style, fragment);
    scrubCssom(root);
    const el = root.querySelector("svg");
    svgText = el ? new XMLSerializer().serializeToString(el) : "";
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = "";
    error.value = "";
    rendered.value = true;
  } catch (e) {
    if (id !== run) return;
    // Parser messages are "Parse error on line N:", a source excerpt, then the reason.
    const lines = (e instanceof Error ? e.message : String(e)).split("\n").map(l => l.trim()).filter(Boolean);
    const reason = lines.length > 1 ? ` ${lines[lines.length - 1]}` : "";
    error.value = `Diagram error: ${lines[0] ?? "unknown"}${reason}`;
  }
}

// An SVG shown as an image cannot run script or load resources, so the lightbox gets a blob URL.
function expand() {
  if (!svgText) return;
  imageUrl ||= URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
  openImage(imageUrl, "Diagram");
}

watch(() => [props.source, props.closed], render, { flush: "post" });
onMounted(render);
onUnmounted(() => { run++; if (imageUrl) URL.revokeObjectURL(imageUrl); });
</script>

<template>
  <Block :source="source" label="Diagram" :building="closed ? undefined : 'Building diagram…'" :error="error">
    <template #tools>
      <button v-if="rendered" type="button" title="Expand" aria-label="Expand diagram" @click="expand"><Maximize2 :size="14" /></button>
    </template>
    <div class="diagram">
      <p v-if="!rendered" class="pending" role="status">Rendering diagram…</p>
      <div ref="host" class="diagram-host" role="button" tabindex="0" aria-label="Expand diagram" @click="expand" @keydown.enter.prevent="expand" @keydown.space.prevent="expand" />
    </div>
  </Block>
</template>

<style scoped>
.diagram { padding: 14px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); overflow-x: auto; }
.diagram-host { cursor: zoom-in; }
.diagram-host:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: var(--radius); }
.pending { margin: 0; font-size: 13px; color: var(--muted-foreground); }
</style>
