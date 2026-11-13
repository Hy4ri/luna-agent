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
#welcome .welcome-mark { padding: 12px; margin-bottom: 14px; }
#welcome h2 { font-size: 20px; line-height: 1.3; letter-spacing: -0.015em; font-weight: 600; margin: 0 0 8px; color: var(--foreground); }
#welcome p { font-size: 14px; line-height: 1.55; font-weight: 400; color: var(--muted-foreground); margin: 0; }
@media (max-width: 760px) {
  #welcome { padding: 28px 12px; }
}
</style>
