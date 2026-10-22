<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ChevronRight } from "@lucide/vue";
import { json } from "@/lib/api";

const loading = ref(true);
const errorMsg = ref("");
const skillsList = ref<any[]>([]);
const skillDetails = ref<Record<string, { body: string; files: string[] }>>({});
const expandedSkills = ref<Record<string, boolean>>({});
const skillErrors = ref<Record<string, string>>({});

async function fetchData() {
  loading.value = true;
  errorMsg.value = "";
  try {
    const r = await json("/v1/skills");
    skillsList.value = r.skills || [];
  } catch (e: any) {
    if (e.message !== "unauthorized") {
      errorMsg.value = e.message;
    }
  } finally {
    loading.value = false;
  }
}

async function toggleSkill(name: string, isExpanded: boolean) {
  expandedSkills.value[name] = isExpanded;
  if (!isExpanded || skillDetails.value[name]) return;
  skillErrors.value[name] = "";
  try { skillDetails.value[name] = await json("/v1/skills/" + encodeURIComponent(name)); }
  catch (error: any) { skillErrors.value[name] = error.message || "Could not load skill instructions. Close and reopen to retry."; }
}

onMounted(() => {
  fetchData();
});
</script>

<template>
  <div class="grid">
    <!-- Loading / Error -->
    <p v-if="loading" class="muted" role="status">Loading…</p>
    <p v-if="errorMsg" class="msg err">{{ errorMsg }}</p>

    <p v-if="!loading && !skillsList.length" class="muted">
      No skills yet. Luna creates them with skill_propose, or drop SKILL.md files into the skills directory.
    </p>

    <details v-for="s in skillsList" :key="s.name" class="card" :data-skill="s.name" @toggle="toggleSkill(s.name, ($event.target as HTMLDetailsElement).open)"><summary class="row"><ChevronRight :size="16" /><b class="grow">{{ s.name }}</b></summary><div class="grid manager-body">
      <div dir="auto" class="muted">{{ s.description }}</div>
      <div v-if="s.tools && s.tools.length" class="muted">tools: {{ s.tools.join(", ") }}</div>
      <p v-if="skillErrors[s.name]" class="msg err" role="alert">{{ skillErrors[s.name] }}</p>
      <pre v-if="expandedSkills[s.name]">{{ skillDetails[s.name]?.body || '' }}{{ skillDetails[s.name]?.files?.length ? '\n\nfiles: ' + skillDetails[s.name].files.join(', ') : '' }}</pre>
    </div></details>
  </div>
</template>
