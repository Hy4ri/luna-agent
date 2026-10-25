import { watch } from "vue";
import { serverUrl, token } from "@/lib/api";

export type CacheEntry<T> = { data: T; fetchedAt: number };
type Entry = { value?: CacheEntry<unknown>; pending?: Promise<unknown> };
const entries = new Map<string, Entry>();
export function clear() { entries.clear(); }
export function forget(key: string) { entries.delete(key); }
watch([serverUrl, token], clear, { flush: 'sync' });

// Context is scoped by synchronous invalidation, not by embedding credentials in keys.
export function makeKey(scope: string, parts: Record<string, string | number | boolean | null | undefined>) {
  const { owner, name, ...rest } = parts;
  return JSON.stringify([owner && name ? `${owner}/${name}`.toLowerCase() : '', scope, rest]);
}
export function get<T>(key: string): CacheEntry<T> | undefined { return entries.get(key)?.value as CacheEntry<T> | undefined; }
export function dropRepo(owner: string, name: string) {
  const repo = `${owner}/${name}`.toLowerCase();
  for (const key of entries.keys()) if (JSON.parse(key)[0] === repo) entries.delete(key);
}
/** Always refresh; callers render get() first. Superseded promises cannot render or refill stale entries. */
export function fetchSWR<T>(key: string, load: () => Promise<T>, fresh = false, keep: (value: T) => boolean = () => true): Promise<T> {
  const previous = entries.get(key);
  if (!fresh && previous?.pending) return previous.pending as Promise<T>;
  const entry: Entry = { value: previous?.value };
  const pending = Promise.resolve().then(load).then(data => {
    if (entries.get(key) !== entry) throw new DOMException('GitHub request superseded', 'AbortError');
    if (keep(data)) { entry.value = { data, fetchedAt: Date.now() }; delete entry.pending; }
    else entries.delete(key);
    return data;
  }, error => {
    if (entries.get(key) === entry) {
      delete entry.pending;
      if (!entry.value) entries.delete(key);
    }
    throw error;
  });
  entry.pending = pending;
  entries.delete(key); entries.set(key, entry);
  while (entries.size > 100) entries.delete(entries.keys().next().value!);
  return pending;
}
