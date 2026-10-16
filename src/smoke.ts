// Smoke test: every package must resolve and export something under this Node.
const pkgs = [
  "@earendil-works/pi-durable",
  "@earendil-works/pi-ai",
  "@earendil-works/chord",
];
let failed = 0;
console.log(`node ${process.version}`);
for (const p of pkgs) {
  try {
    const m = await import(p);
    const n = Object.keys(m).length;
    if (n === 0) throw new Error("no exports");
    console.log(`ok   ${p} (${n} exports)`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${p}: ${(e as Error).message}`);
  }
}
process.exitCode = failed ? 1 : 0;
