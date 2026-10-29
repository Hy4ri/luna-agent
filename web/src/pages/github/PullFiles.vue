<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { fetchPullFiles } from "./client";
import FileDiffList from "../source-control/FileDiffList.vue";
import type { PullFile } from "../../../../src/github";

/** headOid: reload when new commits arrive on the pull request. */
const props = defineProps<{ repo: string; number: number; headOid: string; url: string; wide: boolean }>();
const files = ref<PullFile[]>([]), page = ref(0), more = ref(false), loading = ref(false), error = ref<string | null>(null);
let epoch = 0;
onUnmounted(() => { epoch++; });

async function load(reset: boolean) {
  const [owner, name] = props.repo.split("/");
  if (!owner || !name) return;
  const mine = reset ? ++epoch : epoch, next = reset ? 1 : page.value + 1;
  loading.value = true; error.value = null;
  try {
    const result = await fetchPullFiles(owner, name, props.number, next, reset && page.value > 0);
    if (mine !== epoch) return;
    files.value = reset ? result.files : [...files.value, ...result.files];
    page.value = next; more.value = result.more;
  } catch (e) { if (mine === epoch) error.value = (e as Error).message; }
  finally { if (mine === epoch) loading.value = false; }
}
watch(() => [props.repo, props.number, props.headOid], () => { void load(true); }, { immediate: true });
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <p v-if="error" role="alert" class="px-3 py-2 text-xs text-destructive border-b border-border">{{ error }}</p>
    <p v-if="loading && !files.length" class="p-4 text-xs text-muted-foreground">Loading files…</p>
    <div v-else class="flex-1 min-h-0 overflow-hidden">
      <FileDiffList :files="files" :wide="wide" :external-url="`${url}/files`" />
    </div>
    <div v-if="more" class="px-3 py-1.5 border-t border-border text-xs shrink-0">
      <button type="button" class="underline text-muted-foreground disabled:opacity-50" :disabled="loading" @click="load(false)">{{ loading ? 'Loading…' : 'Load more files' }}</button>
    </div>
  </div>
</template>
