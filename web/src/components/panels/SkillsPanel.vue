<script setup lang="ts">
import { ref, onMounted } from "vue";
import { json } from "@/lib/api";

const loading = ref(true);
const errorMsg = ref("");
const skillsList = ref<any[]>([]);
const skillDetails = ref<Record<string, { body: string; files: string[] }>>({});
const expandedSkills = ref<Record<string, boolean>>({});

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

async function toggleSkill(name: string) {
  const isExpanded = !!expandedSkills.value[name];
  if (!isExpanded && !skillDetails.value[name]) {
    try {
      const d = await json("/v1/skills/" + encodeURIComponent(name));
      skillDetails.value[name] = d;
    } catch {
      // ignore
    }
  }
  expandedSkills.value[name] = !isExpanded;
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

    <div v-for="s in skillsList" :key="s.name" class="card">
      <div class="row">
        <b class="grow">{{ s.name }}</b>
        <button @click="toggleSkill(s.name)">{{ expandedSkills[s.name] ? 'Hide' : 'View' }}</button>
      </div>
      <div class="muted">{{ s.description }}</div>
      <div v-if="s.tools && s.tools.length" class="muted">tools: {{ s.tools.join(", ") }}</div>
      <pre v-if="expandedSkills[s.name]" hidden="">{{ skillDetails[s.name]?.body || '' }}{{ skillDetails[s.name]?.files?.length ? '\n\nfiles: ' + skillDetails[s.name].files.join(', ') : '' }}</pre>
    </div>
  </div>
</template>
