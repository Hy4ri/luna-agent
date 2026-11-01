import { ref } from "vue";

export function useToast(timeoutMs = 2500) {
  const toasts = ref<string[]>([]);

  function toast(text: string) {
    toasts.value.push(text);
    setTimeout(() => {
      const idx = toasts.value.indexOf(text);
      if (idx !== -1) toasts.value.splice(idx, 1);
    }, timeoutMs);
  }

  return { toasts, toast };
}
