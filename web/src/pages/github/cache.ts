import { watch } from "vue";
import { serverUrl, token } from "@/lib/api";

export type CacheEntry<T> = { data: T; fetchedAt: number };
type Entry = { value?: CacheEntry<unknown>; pending?: Promise<unknown>; controller: AbortController; consumers: number };
const entries = new Map<string, Entry>();
function clear() { for (const entry of entries.values()) entry.controller.abort(); entries.clear(); }
export function forget(key: string) { entries.get(key)?.controller.abort(); entries.delete(key); }
watch([serverUrl, token], clear, { flush: 'sync' });

export function makeKey(scope: string, parts: Record<string, string | number | boolean | null | undefined>) {
  const { owner, name, ...rest } = parts;
  return JSON.stringify([owner && name ? `${owner}/${name}`.toLowerCase() : '', scope, rest]);
}
export function get<T>(key: string): CacheEntry<T> | undefined { return entries.get(key)?.value as CacheEntry<T> | undefined; }
export function dropRepo(owner: string, name: string) {
  const repo = `${owner}/${name}`.toLowerCase();
  for (const key of entries.keys()) if (JSON.parse(key)[0] === repo) forget(key);
}

/** A consumer owns its wait, not another view's shared transport. */
function subscribe<T>(key: string, entry: Entry, signal?: AbortSignal): Promise<T> {
  entry.consumers++;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (deliver: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      entry.consumers--;
      if (!entry.consumers && entry.pending) {
        if (!entry.value && entries.get(key) === entry) entries.delete(key);
        entry.controller.abort();
      }
      deliver();
    };
    const abort = () => finish(() => reject(signal?.reason ?? new DOMException('Request cancelled', 'AbortError')));
    entry.pending!.then(data => finish(() => resolve(data as T)), error => finish(() => reject(error)));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Render get() first, then refresh. Cancel transport only when every consumer has left. */
export function fetchSWR<T>(key: string, load: (signal: AbortSignal) => Promise<T>, fresh = false, keep: (value: T) => boolean = () => true, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const previous = entries.get(key);
  if (!fresh && previous?.pending) return subscribe(key, previous, signal);
  const entry: Entry = { value: previous?.value, controller: new AbortController(), consumers: 0 };
  previous?.controller.abort();
  const pending = Promise.resolve().then(() => load(entry.controller.signal)).then(data => {
    if (entries.get(key) !== entry || entry.controller.signal.aborted) throw new DOMException('GitHub request superseded', 'AbortError');
    if (keep(data)) entry.value = { data, fetchedAt: Date.now() };
    else entries.delete(key);
    return data;
  }).finally(() => {
    delete entry.pending;
    if (!entry.value && entries.get(key) === entry) entries.delete(key);
  });
  entry.pending = pending;
  entries.delete(key); entries.set(key, entry);
  while (entries.size > 100) forget(entries.keys().next().value!);
  return subscribe(key, entry, signal);
}
