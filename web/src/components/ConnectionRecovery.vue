<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription } from 'reka-ui';
import { ArrowRightLeft, LoaderCircle } from '@lucide/vue';
import { activeAddress, checkAddress, connection, connectionFailure, preferredAddress, recoveryDismissed, recoveryOpen } from '@/lib/connections';
import { changeConnection } from '@/stores/app';
const busy = ref('');
const error = ref('');
let attempt = 0;
const alternatives = computed(() => connection.value?.addresses.filter(a => a.url !== activeAddress() && (connectionFailure.value || a.url === preferredAddress.value)) ?? []);
watch(recoveryOpen, open => {
  if (open) error.value = '';
  else { attempt++; busy.value = ''; }
});
async function connect(address: string) {
  if (busy.value) return;
  const own = ++attempt;
  busy.value = address; error.value = '';
  try {
    const target = await checkAddress(address);
    if (own !== attempt || !recoveryOpen.value) return;
    changeConnection(target, !connectionFailure.value);
  }
  catch (e) { if (own !== attempt) return; error.value = (e as Error).message === 'Failed to fetch' ? 'Cannot reach this address. Check Wi-Fi or Tailscale, then try again.' : (e as Error).message; }
  finally { if (own === attempt) busy.value = ''; }
}
function updateOpen(open: boolean) {
  if (!open) { attempt++; busy.value = ''; recoveryDismissed.value = true; }
}
</script>

<template>
  <DialogRoot :open="recoveryOpen" @update:open="updateOpen">
    <DialogPortal>
      <DialogOverlay class="recovery-overlay" />
      <DialogContent class="connection-recovery" data-connection-recovery @interact-outside.prevent>
        <div class="recovery-title"><ArrowRightLeft :size="20" aria-hidden="true" /><DialogTitle>{{ connectionFailure ? 'Connection lost' : 'Preferred address available' }}</DialogTitle></div>
        <DialogDescription class="recovery-description">Choose an address for this daemon. Your draft stays here. Messages are not resent.</DialogDescription>
        <p class="current-address">{{ connectionFailure ? 'Disconnected from' : 'Current address' }} <span>{{ activeAddress() }}</span></p>
        <div class="recovery-addresses" :aria-busy="!!busy">
          <button v-for="address in alternatives" :key="address.url" type="button" class="address-button" :disabled="!!busy" @click="connect(address.url)">
            <span><strong>{{ busy === address.url ? 'Checking daemon…' : 'Switch to ' + address.label }}</strong><small>{{ address.url }}</small></span>
            <LoaderCircle v-if="busy === address.url" :size="20" class="checking" aria-hidden="true" /><ArrowRightLeft v-else :size="20" aria-hidden="true" />
          </button>
        </div>
        <p v-if="busy" role="status" class="recovery-description">Checking that this address reaches the same daemon…</p>
        <p v-if="error" role="alert" class="recovery-error">{{ error }}</p>
        <button type="button" class="dismiss-button" @click="updateOpen(false)">Not now</button>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.recovery-overlay { position: fixed; inset: 0; z-index: 110; background: rgb(0 0 0 / 0.56); }
.connection-recovery { position: fixed; z-index: 111; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(28rem, calc(100% - 2rem)); max-height: calc(100dvh - 2rem); overflow-y: auto; overscroll-behavior: contain; display: grid; gap: 1rem; border: 1px solid var(--border); border-radius: var(--radius); padding: 1.25rem; background: var(--card); color: var(--foreground); box-shadow: 0 8px 32px rgb(0 0 0 / 0.31); }
.recovery-title { display: flex; align-items: center; gap: .65rem; font-size: 1.1rem; font-weight: 600; }
.recovery-description, .current-address { color: var(--muted-foreground); font-size: .875rem; line-height: 1.5; }
.current-address span { display: block; overflow-wrap: anywhere; }
.recovery-addresses { display: grid; gap: .75rem; }
.address-button, .dismiss-button { min-height: 48px; border: 1px solid var(--border); border-radius: var(--radius); padding: .75rem; font-size: 1rem; cursor: pointer; }
.address-button { display: flex; align-items: center; justify-content: space-between; gap: .75rem; width: 100%; text-align: start; background: var(--background); }
.address-button span { min-width: 0; }
.address-button strong { display: block; font-weight: 600; }
.address-button small { display: block; margin-top: .3rem; font-size: .8rem; color: var(--muted-foreground); overflow-wrap: anywhere; }
.address-button svg { flex-shrink: 0; }
button:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; }
button:disabled { opacity: .6; cursor: wait; }
.dismiss-button { width: 100%; }
.recovery-error { color: var(--destructive); font-size: .875rem; line-height: 1.5; }
.checking { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .checking { animation: none; } }
@media (max-width: 639px) {
  .connection-recovery { top: auto; bottom: 0; left: 0; transform: none; width: 100%; max-height: calc(100dvh - 1rem); border-radius: var(--radius) var(--radius) 0 0; padding: 1.25rem 1rem max(1rem, env(safe-area-inset-bottom)); }
}
</style>
