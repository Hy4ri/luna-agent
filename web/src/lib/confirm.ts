import { ref } from "vue";

export interface AskOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Show a text field. The promise resolves to its value instead of true. */
  input?: { label: string; placeholder?: string; required?: boolean };
}

interface Pending extends AskOptions { resolve: (value: string | boolean | null) => void }

export const pending = ref<Pending | null>(null);

function ask(options: AskOptions): Promise<string | boolean | null> {
  pending.value?.resolve(options.input ? null : false);
  return new Promise((resolve) => { pending.value = { ...options, resolve }; });
}

/** Themed replacement for window.confirm. Resolves true on confirm, false on cancel. */
export async function confirmAction(options: Omit<AskOptions, "input">): Promise<boolean> {
  return (await ask(options)) === true;
}

/** Themed replacement for window.prompt. Resolves to the text, or null on cancel. */
export async function promptText(options: AskOptions & { input: NonNullable<AskOptions["input"]> }): Promise<string | null> {
  const value = await ask(options);
  return typeof value === "string" ? value : null;
}

export function settle(value: string | boolean | null) {
  const current = pending.value;
  pending.value = null;
  current?.resolve(value);
}
