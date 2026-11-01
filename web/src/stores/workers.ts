// Execution machines registered with this daemon. Online state is live only while refreshed.
import { reactive } from "vue";
import { json, serverUrl, token } from "@/lib/api";

export interface WorkerRow {
  id: number; name: string; online: boolean; createdAt: number; lastSeenAt: number | null; connectedAt: number | null;
  capabilities: { hostname: string; platform: string; arch: string; user: string; cwd: string } | null;
}
export interface Machine { id: number; name: string | null; online: boolean }

export const workers = reactive({ list: [] as WorkerRow[], loaded: false });

let inFlightWorkers: { origin: string; credential: string; promise: Promise<WorkerRow[]> } | null = null;

export async function loadWorkers(): Promise<WorkerRow[]> {
  const origin = serverUrl.value, credential = token.value;
  if (inFlightWorkers && inFlightWorkers.origin === origin && inFlightWorkers.credential === credential) {
    return inFlightWorkers.promise;
  }

  const task = (async () => {
    const r = await json<{ workers: WorkerRow[] }>("/v1/workers");
    if (origin !== serverUrl.value || credential !== token.value) return workers.list;
    workers.list = r.workers; workers.loaded = true;
    return workers.list;
  })();

  const current = { origin, credential, promise: task };
  inFlightWorkers = current;
  const cleanup = () => { if (inFlightWorkers === current) inFlightWorkers = null; };
  task.then(cleanup, cleanup);
  return task;
}
