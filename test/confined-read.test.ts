// Contract: confinedRead returns bytes only from a regular file inside the allowed roots, never from a credential
// or blocked path, and never more than the limit. The model controls `path`, so every refusal here is a security boundary.
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll as after, test } from "bun:test";
import { ConfinedReadError, confinedRead, credentialPath, within } from "../src/confined-read.js";

const base = mkdtempSync(join(tmpdir(), "luna-confined-"));
after(() => rmSync(base, { recursive: true, force: true }));
const root = join(base, "work");
const sibling = join(base, "work2"); // Shares the root's string prefix.
const outside = join(base, "outside");
for (const dir of [root, sibling, outside, join(root, "sub")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(root, "ok.txt"), "inside");
writeFileSync(join(root, "sub", "deep.txt"), "deep");
writeFileSync(join(sibling, "x.txt"), "sibling");
writeFileSync(join(outside, "secret.txt"), "outside");
symlinkSync(join(outside, "secret.txt"), join(root, "link-out.txt"));
symlinkSync(join(root, "ok.txt"), join(root, "link-in.txt"));

const read = (path: string, policy: Partial<Parameters<typeof confinedRead>[1]> = {}, afterOpen?: () => Promise<void>) =>
  confinedRead(path, { root, maxBytes: 1024, ...policy }, { cwd: root, ...(afterOpen ? { afterOpen } : {}) });
const text = async (p: Promise<Uint8Array>) => Buffer.from(await p).toString("utf8");
const refused = (p: Promise<unknown>, pattern: RegExp) => assert.rejects(p, (e: unknown) => e instanceof ConfinedReadError && pattern.test(e.message));

test("reads files inside the root by relative or absolute path, including symlinks that stay inside", async () => {
  assert.equal(await text(read("ok.txt")), "inside");
  assert.equal(await text(read(join(root, "sub", "deep.txt"))), "deep");
  assert.equal(await text(read("link-in.txt")), "inside");
});

test("refuses traversal, outward symlinks, and sibling directories that share the root prefix", async () => {
  await refused(read("../outside/secret.txt"), /outside the conversation working directory/);
  await refused(read("link-out.txt"), /outside the conversation working directory/);
  await refused(read(join(sibling, "x.txt")), /outside the conversation working directory/);
});

test("a path swapped for a symlink after open still reads the opened file", async () => {
  const path = join(root, "swap.txt");
  writeFileSync(path, "original");
  const got = await text(read("swap.txt", {}, async () => {
    renameSync(path, join(root, "moved.txt"));
    symlinkSync(join(outside, "secret.txt"), path);
  }));
  assert.equal(got, "original");
  unlinkSync(path);
});

test("a file deleted after open is refused, because its location can no longer be checked", async () => {
  const path = join(root, "gone.txt");
  writeFileSync(path, "x");
  await refused(read("gone.txt", {}, async () => unlinkSync(path)), /changed while it was opened/);
});

test("refuses credential files by name and blocked paths, including hard-link aliases", async () => {
  for (const name of [".env", ".env.local", "auth.json", "luna.config.json"]) {
    writeFileSync(join(root, name), "token");
    await refused(read(name, { credentials: true }), /credential file/);
  }
  const blocked = join(outside, "auth-store.txt");
  writeFileSync(blocked, "token");
  linkSync(blocked, join(root, "alias.txt"));
  await refused(read("alias.txt", { blocked: [blocked] }), /alias/);
  await refused(read(join(root, "sub", "deep.txt"), { blocked: [join(root, "sub")] }), /blocked path/);
});

test("credentialPath matches whole path components only", () => {
  for (const p of ["/h/.ssh/id_ed25519", "/h/.aws/credentials", "/p/.env", "/p/.env.production", "/d/auth.json",
    "/d/secrets.json", "/r/luna.config.json", "/r/luna.config.pre-x.json"]) assert.equal(credentialPath(p), true, p);
  for (const p of ["/p/.environment", "/p/my.env", "/d/oauth.json", "/r/luna.config.example.ts", "/p/env/file"]) {
    assert.equal(credentialPath(p), false, p);
  }
});

test("within compares whole directory components", () => {
  assert.equal(within("/a/b", "/a/b"), true);
  assert.equal(within("/a/b/c", "/a/b"), true);
  assert.equal(within("/a/bc", "/a/b"), false);
  assert.equal(within("/a/b/c", "/a/b/"), true);
});

test("refuses directories, oversized files, and invalid input", async () => {
  await refused(read("sub"), /regular file/);
  writeFileSync(join(root, "big.bin"), Buffer.alloc(1025));
  await refused(read("big.bin"), /1024-byte limit/);
  writeFileSync(join(root, "exact.bin"), Buffer.alloc(1024, 7));
  assert.equal((await read("exact.bin")).length, 1024);
  await refused(read(""), /Invalid source path/);
  await refused(read("ok.txt", { maxBytes: 0 }), /Invalid read limit/);
});

test("roots: missing directories grant nothing; one existing root is enough", async () => {
  await refused(read("ok.txt", { root: undefined, roots: [join(base, "missing")] }), /No allowed image directory/);
  assert.equal(await text(read("ok.txt", { root: undefined, roots: [join(base, "missing"), root] })), "inside");
  await refused(read("../outside/secret.txt", { root: undefined, roots: [root] }), /outside the allowed source directories/);
});
