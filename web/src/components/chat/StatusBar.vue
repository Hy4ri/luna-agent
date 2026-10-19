<script setup lang="ts">
import { status, usageText, contextView } from "@/stores/chat";
</script>

<template>
  <div id="statusbar">
    <div id="status">{{ status }}</div>
    <div id="context-bar" :hidden="!contextView" :data-level="contextView?.level" :title="contextView?.title">
      <div id="context-meter" :hidden="!contextView?.known" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="contextView?.percent" :aria-valuetext="contextView?.valueText">
        <div id="context-fill" :style="{ width: contextView?.percent + '%' }"></div>
      </div>
      <span id="context-text">{{ contextView?.text }}</span>
    </div>
    <div id="usage">{{ usageText }}</div>
  </div>
</template>
