import { ref } from "vue";

// Shared by the transcript and composer; neither owns the other's DOM or draft.
export const scheduleRevision = ref(0);
export const scheduleReveal = ref(0);
export function schedulesChanged() { scheduleRevision.value++; }
export function revealSchedules() { scheduleReveal.value++; }
