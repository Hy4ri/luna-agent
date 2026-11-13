<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { activeAddress, connection, normalizeAddress, saveAddresses, type ConnectionAddress } from '@/lib/connections';
defineProps<{ disabled?: boolean }>();
const addresses = ref<ConnectionAddress[]>([]);
const prompt = ref(true);
const error = ref('');
const notice = ref('');
watch(connection, value => {
  addresses.value = value?.addresses.map(a => ({ ...a })) ?? [];
  prompt.value = value?.prompt ?? true;
}, { immediate: true });
const normalized = computed(() => addresses.value.filter(a => a.url.trim()).map(a => {
  try { return { ...a, url: normalizeAddress(a.url), invalid: '' }; }
  catch (e) { return { ...a, invalid: (e as Error).message }; }
}));
const problem = computed(() => {
  const bad = normalized.value.find(a => a.invalid);
  if (bad) return bad.invalid;
  const urls = normalized.value.map(a => a.url);
  return new Set(urls).size !== urls.length ? 'Each address must be different.' : '';
});
const dirty = computed(() => {
  const saved = connection.value;
  if (!saved) return false;
  const now = normalized.value.map(a => `${a.label.trim() || 'Server'}|${a.url}`);
  const before = saved.addresses.map(a => `${a.label}|${a.url}`);
  return prompt.value !== saved.prompt || now.length !== before.length || now.some((v, i) => v !== before[i]);
});
function guardSwitch(event: Event) {
  if (dirty.value) (event as CustomEvent).detail.error = 'Save or discard address edits before switching addresses.';
}
onMounted(() => window.addEventListener('luna:can-switch-connection', guardSwitch));
onBeforeUnmount(() => window.removeEventListener('luna:can-switch-connection', guardSwitch));
function save() {
  if (problem.value || !dirty.value) return;
  error.value = ''; notice.value = '';
  try { saveAddresses(addresses.value, prompt.value); notice.value = 'Addresses saved on this device.'; }
  catch (e) { error.value = (e as Error).message; }
}
</script>

<template>
  <section class="daemon-connection" aria-label="Daemon connection addresses" data-section="daemon-addresses">
    <h3 tabindex="-1">Connection addresses</h3>
    <p class="muted">Set the LAN, Tailscale, and public HTTPS addresses for the same daemon. Earlier addresses have higher priority. Luna checks them when you return to the app.</p>
    <p class="current-address">Current address: <code>{{ activeAddress() }}</code></p>
    <p v-if="!connection" class="muted">Connect to an updated daemon once to save its addresses on this device.</p>
    <fieldset v-else :disabled="disabled" class="route-controls">
      <div v-for="(address, index) in addresses" :key="index" class="saved-address">
        <label>Label<input v-model="address.label" :aria-label="`Address ${index + 1} label`" placeholder="LAN or Tailscale" autocomplete="off" /></label>
        <label>IP address or URL<input v-model="address.url" :aria-label="`Address ${index + 1} URL`" placeholder="192.168.1.10:8787 or https://luna.example.com" inputmode="url" autocapitalize="none" :spellcheck="false" autocomplete="off" /></label>
        <div class="route-order">
          <button type="button" :disabled="index === 0" :aria-label="`Move address ${index + 1} up`" @click="[addresses[index - 1], addresses[index]] = [addresses[index], addresses[index - 1]]">Move up</button>
          <button type="button" :disabled="index === addresses.length - 1" :aria-label="`Move address ${index + 1} down`" @click="[addresses[index], addresses[index + 1]] = [addresses[index + 1], addresses[index]]">Move down</button>
        </div>
        <button type="button" :aria-label="`Remove address ${index + 1}`" @click="addresses.splice(index, 1)">Remove</button>
      </div>
      <button type="button" @click="addresses.push({ label: '', url: '' })">Add address</button>
      <label class="prompt-option"><input v-model="prompt" type="checkbox" />Ask before switching addresses</label>
      <p class="muted">When disabled, Luna switches automatically after checking daemon identity. Preferred-route changes wait until the current turn ends.</p>
      <p v-if="problem" role="alert" class="route-error">{{ problem }}</p>
      <button type="button" class="save-addresses" :disabled="!!problem || !dirty" @click="save">Save addresses</button>
      <p class="muted">Use Save addresses, not Save settings. Addresses stay on this device and do not change where the daemon listens.</p>
    </fieldset>
    <p v-if="error" role="alert" class="route-error">{{ error }}</p>
    <p v-if="notice" role="status" class="muted">{{ notice }}</p>
  </section>
</template>

<style scoped>
.daemon-connection { display: grid; gap: .75rem; min-width: 0; padding: 1rem; border: 1px solid var(--border); border-radius: .65rem; }
h3 { font-size: .95rem; font-weight: 600; }
p { font-size: .875rem; line-height: 1.5; overflow-wrap: anywhere; }
.muted { color: var(--muted-foreground); }
.route-controls { display: grid; gap: .75rem; min-width: 0; }
label { display: grid; gap: .4rem; font-size: .875rem; min-width: 0; }
input:not([type=checkbox]), button { min-height: 44px; border: 1px solid var(--border); border-radius: .4rem; padding: .65rem; background: var(--background); font-size: 1rem; min-width: 0; max-width: 100%; }
button { width: fit-content; cursor: pointer; }
button:disabled { opacity: .55; cursor: not-allowed; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
fieldset:disabled { opacity: .55; }
.saved-address { display: grid; gap: .5rem; border-bottom: 1px solid var(--border); padding-bottom: .75rem; }
.route-order { display: flex; flex-wrap: wrap; gap: .5rem; }
.prompt-option { display: flex; align-items: center; gap: .75rem; min-height: 44px; cursor: pointer; }
.prompt-option input { width: 20px; height: 20px; flex-shrink: 0; }
.route-error { color: var(--destructive); }
@media (max-width: 639px) { .save-addresses { width: 100%; } }
</style>
