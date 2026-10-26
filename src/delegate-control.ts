// Serialize native child admission and abort in this process. Durable rows fence the same operations after restart.
// The installed guarded-input contract accepts reject only, so steering uses this lock instead of a queue guard.
const controls = new Map<number, Promise<unknown>>();
export async function withChildControl<T>(id: number, run: () => Promise<T>): Promise<T> {
  const previous = controls.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  controls.set(id, next);
  try { return await next; }
  finally { if (controls.get(id) === next) controls.delete(id); }
}
