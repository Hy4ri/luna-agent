<script setup lang="ts">
import { onMounted } from "vue";
import { backgroundSends, initializeBackgroundSends, retryBackgroundSend, dismissBackgroundSend } from "@/stores/background-send";
import { openSession, addErr } from "@/stores/chat";
import { confirmAction } from "@/lib/confirm";

onMounted(() => { void initializeBackgroundSends().catch(error => addErr((error as Error).message)); });
async function dismiss(id: string, accepted: boolean) {
  if (!accepted && !await confirmAction({
    title: "Discard send recovery?",
    message: "This removes the saved message and its retry handle. It does not stop or delete a session, and an unconfirmed message may already have arrived.",
    confirmLabel: "Discard recovery", danger: true,
  })) return;
  try { await dismissBackgroundSend(id); } catch (error) { addErr((error as Error).message); }
}
function retry(id: string) { void retryBackgroundSend(id).catch(error => addErr((error as Error).message)); }
</script>

<template>
  <section v-if="backgroundSends.length" class="background-sends" aria-label="Background sends" aria-live="polite">
    <div v-for="send in backgroundSends" :key="send.id" class="background-send">
      <span class="background-send-label">
        <template v-if="send.status === 'accepted'">Sent to a new session</template>
        <template v-else-if="send.status === 'sending'">Sending to a new session…</template>
        <template v-else>Background send not confirmed</template>
        <span v-if="send.message" class="background-send-detail">{{ send.message }}</span>
      </span>
      <div class="background-send-actions">
        <button v-if="send.sessionId" type="button" @click="openSession(send.sessionId)">Open</button>
        <button v-if="send.status === 'error' || send.status === 'uncertain'" type="button" :disabled="send.busy" @click="retry(send.id)">Retry</button>
        <button v-if="send.status !== 'sending'" type="button" :disabled="send.busy" @click="dismiss(send.id, send.status === 'accepted')">Dismiss</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.background-sends { display: grid; gap: 8px; margin-bottom: 8px; max-height: 180px; overflow-y: auto; }
.background-send { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius); font-size: 12px; }
.background-send-label { min-width: 0; overflow-wrap: anywhere; }
.background-send-detail { display: block; color: var(--muted-foreground); white-space: pre-wrap; }
.background-send-actions { display: flex; gap: 8px; flex-shrink: 0; }
.background-send-actions button { min-height: 32px; min-width: 32px; padding: 4px 6px; text-decoration: underline; text-underline-offset: 3px; border-radius: var(--radius); }
.background-send-actions button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.background-send-actions button:disabled { opacity: .5; }
@media (max-width: 760px), (pointer: coarse) {
  .background-send-actions button { min-height: 44px; min-width: 44px; padding: 6px 10px; }
}
</style>
