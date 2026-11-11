// One persistent identity per daemon data directory; network addresses are not identities.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

export function daemonConnection(dataDir: string, host: string, port: number, publicUrls: string[] = []) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "connection-id");
  try { writeFileSync(file, crypto.randomUUID(), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const id = readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid daemon connection-id");
  const addresses = () => Object.values(networkInterfaces()).flatMap(rows => rows ?? [])
    .filter(row => !row.internal && row.family === "IPv4" && (host === "0.0.0.0" || host === "::" || host === row.address))
    .map(row => ({ url: `http://${row.address}:${port}`, label: /^100\./.test(row.address) && Number(row.address.split(".")[1]) >= 64 && Number(row.address.split(".")[1]) <= 127 ? "Tailscale" : "LAN" }))
    .concat(publicUrls.map(url => ({ url: new URL(url).origin, label: "Public" })));
  const origins = new Set<string>();
  // networkInterfaces() is a syscall-heavy call; refresh at most every few seconds, and only on an unknown origin.
  let refreshedAt = 0;
  const rememberOrigins = () => {
    refreshedAt = Date.now();
    for (const address of addresses()) origins.add(address.url);
    if (["0.0.0.0", "::", "127.0.0.1", "::1", "localhost"].includes(host)) {
      for (const name of ["localhost", "127.0.0.1", "[::1]"]) origins.add(`http://${name}:${port}`);
    }
  };
  rememberOrigins();
  return {
    id,
    info: () => ({ id, addresses: addresses() }),
    // Only origins hosted by this daemon, not arbitrary websites, may use bearer-authenticated cross-origin requests.
    allowsOrigin: (origin: string) => {
      if (origins.has(origin)) return true;
      if (Date.now() - refreshedAt >= 5000) rememberOrigins();
      return origins.has(origin);
    },
  };
}
