type Entry = { at: number; value?: unknown; pending?: Promise<unknown> };

/** Bounded per-app reads. Invalidated or replaced requests cannot refill the cache. */
export function createGithubCache() {
  const entries = new Map<string, Entry>();
  function read<T>(key: string, ttl: number, load: () => Promise<T>, fresh = false, keep: (value: T) => boolean = () => true): Promise<T> {
    const previous = entries.get(key);
    if (!fresh && previous?.pending) return previous.pending as Promise<T>;
    if (!fresh && previous && Date.now() - previous.at < ttl) return Promise.resolve(previous.value as T);
    const entry: Entry = { at: 0 };
    const pending = Promise.resolve().then(load).then(value => {
      if (entries.get(key) === entry) {
        if (keep(value)) { entry.at = Date.now(); entry.value = value; delete entry.pending; }
        else entries.delete(key);
      }
      return value;
    }, error => { if (entries.get(key) === entry) entries.delete(key); throw error; });
    entry.pending = pending;
    entries.delete(key); entries.set(key, entry);
    while (entries.size > 200) entries.delete(entries.keys().next().value!);
    return pending;
  }
  function invalidateRepo(repo: string) {
    const prefix = repo.toLowerCase() + '|';
    for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
  }
  return { read, invalidateRepo };
}
