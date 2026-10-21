// Execution machines registered with this daemon. Online state is live only while refreshed.
import { reactive } from "vue";
import { json } from "@/lib/api";

export interface WorkerRow {
  id: number; name: string; online: boolean; createdAt: number; lastSeenAt: number | null; connectedAt: number | null;
  capabilities: { hostname: string; platform: string; arch: string; user: string; cwd: string } | null;
}
export interface Machine { id: number; name: string | null; online: boolean }

export const workers = reactive({ list: [] as WorkerRow[], loaded: false });

export async function loadWorkers() {
  const r = await json<{ workers: WorkerRow[] }>("/v1/workers");
  workers.list = r.workers; workers.loaded = true;
  return workers.list;
}
