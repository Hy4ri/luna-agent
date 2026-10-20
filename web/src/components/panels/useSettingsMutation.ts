import { ref } from "vue";

/** Track the whole live operation, including follow-up reads, for inline Settings. */
export function useSettingsMutation(onChanged: () => void) {
  const pending = ref(false);
  async function run(action: () => Promise<unknown>) {
    if (pending.value) return;
    pending.value = true;
    try { await action(); }
    finally {
      onChanged();
      pending.value = false;
    }
  }
  return { pending, run };
}
