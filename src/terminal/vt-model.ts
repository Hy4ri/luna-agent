// Headless terminal screen for terminals Luna reads, built on the signed libghostty-vt 1.0.1 C ABI WASM.
import { readFileSync } from "node:fs";
import { createVtRuntime, WASM_SHA256, type VtRuntime, type VtScreen } from "./vt-core.js";

export type { VtScreen };
export { WASM_SHA256 };

export interface VtModel {
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  screen(): VtScreen;
  /** The last `count` scrollback lines, oldest first. */
  scrollback(count: number): string[];
  /** DEC private mode, e.g. 1 (application cursor keys) or 2004 (bracketed paste). */
  mode(mode: number): boolean;
  /** Replies the program asked for, such as a cursor position report. Empty when there are none. */
  responses(): string;
  dispose(): void;
}

export type VtFactory = (cols: number, rows: number) => Promise<VtModel>;

const WASM_URL = new URL("ghostty-vt-1.0.1-small.wasm", import.meta.url);
const SCROLLBACK_LINES = 2000;
const SCROLLBACK_BYTES = 10 * 1024 * 1024;

let runtime: Promise<VtRuntime> | undefined;

function getRuntime(): Promise<VtRuntime> {
  return runtime ??= (async () => {
    const raw = readFileSync(WASM_URL);
    const digest = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
    if (digest !== WASM_SHA256)
      throw new Error(`ghostty-vt WASM SHA256 mismatch: expected ${WASM_SHA256}, got ${digest}`);
    return createVtRuntime(raw);
  })().catch(err => {
    runtime = undefined;
    throw err;
  });
}

export async function loadVt(): Promise<VtFactory> {
  const rt = await getRuntime();
  return async (cols, rows) => rt.create(cols, rows, {
    scrollbackLines: SCROLLBACK_LINES,
    scrollbackBytes: SCROLLBACK_BYTES,
  });
}
