<script setup lang="ts">
import { Moon } from "@lucide/vue";
</script>

<template>
  <section id="welcome">
    <div class="welcome-mark" aria-hidden="true">
      <Moon :size="28" />
    </div>
    <h2>What are we working on?</h2>
    <p>Start a conversation, or pick up where you left off.<br />Find workspace tools in Settings.</p>
  </section>
</template>

<style scoped>
#welcome { padding: 40px 16px; }
@media (max-width: 760px) {
  #welcome { padding: 28px 12px; }
}
</style>
