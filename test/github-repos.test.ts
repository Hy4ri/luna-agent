// Regression: Source Control board linking failed for projects that exist only on an execution machine.
// Repository discovery read only the main-host directory, so worker-linked projects never matched their repository.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll as after, test, expect } from "bun:test";
import { createRemoteOrigin, projectRepos, type RemoteReader } from "../src/github.js";
import { startWorker } from "../src/worker.js";
import { WorkerHub, WorkerStore, type WorkerWsData } from "../src/workers.js";

test("project discovery reaches a repository through an execution-machine directory", async () => {
  const calls: [number | null, string][] = [];
  const resolveRemote: RemoteReader = async (machine, cwd) => {
    calls.push([machine, cwd]);
    return machine === 1 && cwd === "/machines/hermes-mobile" ? "Hy4ri/hermes-mobile" : null;
  };

  const repos = await projectRepos(
    [{ id: 102, name: "hermes-mobile", cwd: "", workerDirs: [{ worker: 1, cwd: "/machines/hermes-mobile" }] }],
    { resolveRemote, key: "worker-only" },
  );

  expect(repos).toEqual([{ repo: "Hy4ri/hermes-mobile", projects: [{ id: 102, name: "hermes-mobile" }] }]);
  expect(calls).toEqual([[1, "/machines/hermes-mobile"]]);
});

test("project discovery falls through to a machine and groups projects that share a repository", async () => {
  const seen: string[] = [];
  const resolveRemote: RemoteReader = async (machine, cwd) => {
    seen.push(`${machine ?? "main"}:${cwd}`);
    if (cwd === "/main/no-remote" || cwd === "/machines/offline") return null;
    return cwd === "/machines/project" || cwd === "/main/other-clone" ? "Hy4ri/worker-project" : null;
  };

  const repos = await projectRepos(
    [
      // Main host has a directory but no usable origin; the machine clone answers instead.
      { id: 103, name: "worker-project", cwd: "/main/no-remote", workerDirs: [{ worker: 2, cwd: "/machines/project" }] },
      { id: 104, name: "clone-project", cwd: "/main/other-clone" },
      // Machine offline: no remote, so the project stays out of the list.
      { id: 105, name: "unreachable", cwd: "", workerDirs: [{ worker: 3, cwd: "/machines/offline" }] },
    ],
    { resolveRemote, key: "fallthrough" },
  );

  expect(repos).toEqual([{
    repo: "Hy4ri/worker-project",
    projects: [{ id: 103, name: "worker-project" }, { id: 104, name: "clone-project" }],
  }]);
  expect(seen.includes("main:/main/no-remote")).toBeTruthy();
  expect(seen.includes("2:/machines/project")).toBeTruthy();
  expect(seen.includes("3:/machines/offline")).toBeTruthy();
});

// The production resolver over the real worker transport: the daemon reads a machine directory through the worker.
const dir = mkdtempSync(join(tmpdir(), "luna-github-repos-worker-"));
const machineRepo = join(dir, "machine-repo");
mkdirSync(machineRepo);
const initRes = Bun.spawnSync(["git", "init", "--initial-branch", "main", machineRepo], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
if (!initRes.success) throw new Error("git init failed");
const remoteRes = Bun.spawnSync(["git", "-C", machineRepo, "remote", "add", "origin", "git@github.com:Hy4ri/machine-only.git"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
if (!remoteRes.success) throw new Error("git remote add failed");
const hub = new WorkerHub(new WorkerStore(join(dir, "workers.db")), () => {});
const server = Bun.serve<WorkerWsData>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, srv) {
    const r = hub.tryUpgrade(req, srv);
    if (r !== undefined) return r ?? undefined;
    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    maxPayloadLength: 256 * 1024 * 1024,
    open(ws) { hub.wsOpen(ws); },
    message(ws, msg) { hub.wsMessage(ws, msg); },
    pong(ws) { hub.wsPong(ws); },
    close(ws) { hub.wsClose(ws); },
  },
});
const url = `http://127.0.0.1:${server.port}`;
const { worker, token } = hub.store.create("repos");
const running = startWorker({ url, token, cwd: dir, log: () => {} });
await running.ready;

after(async () => {
  await running.close();
  hub.close();
  await server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("repository discovery reads a machine directory through the worker connection", async () => {
  const repos = await projectRepos(
    [{ id: 201, name: "machine-only", cwd: "", workerDirs: [{ worker: worker.id, cwd: machineRepo }] }],
    { resolveRemote: createRemoteOrigin(hub), key: `worker-${worker.id}` },
  );
  expect(repos).toEqual([{ repo: "Hy4ri/machine-only", projects: [{ id: 201, name: "machine-only" }] }]);
});

test("repository discovery ignores directories on missing machines", async () => {
  const repos = await projectRepos(
    [{ id: 202, name: "gone", cwd: "", workerDirs: [{ worker: worker.id + 100, cwd: machineRepo }] }],
    { resolveRemote: createRemoteOrigin(hub), key: `missing-${worker.id}` },
  );
  expect(repos).toEqual([]);
});
