// node:assert throws/rejects matcher semantics on top of bun:test expect.
// A RegExp is tested against String(error), a class with instanceof, and a predicate must return true.
import { expect } from "bun:test";

export type ErrorMatcher = RegExp | (new (...args: any[]) => unknown) | ((error: any) => boolean);

function check(error: unknown, matcher: ErrorMatcher | undefined, message?: string): void {
  if (matcher === undefined) return;
  if (matcher instanceof RegExp) {
    expect(String(error), message).toMatch(matcher);
    return;
  }
  if (matcher.prototype !== undefined && error instanceof (matcher as new (...args: any[]) => unknown)) return;
  if (matcher.prototype !== undefined && Object.prototype.isPrototypeOf.call(Error.prototype, matcher.prototype)) {
    expect(error, message).toBeInstanceOf(matcher as new (...args: any[]) => unknown);
    return;
  }
  expect((matcher as (error: any) => boolean)(error), message ?? `error did not match: ${String(error)}`).toBe(true);
}

export function throwsWith(fn: () => unknown, matcher?: ErrorMatcher, message?: string): void {
  let thrown = false, error: unknown;
  try { fn(); } catch (e) { thrown = true; error = e; }
  expect(thrown, message ?? "expected the function to throw").toBe(true);
  check(error, matcher, message);
}

export async function rejectsWith(promise: Promise<unknown> | (() => Promise<unknown>), matcher?: ErrorMatcher, message?: string): Promise<void> {
  let rejected = false, error: unknown;
  try { await (typeof promise === "function" ? promise() : promise); } catch (e) { rejected = true; error = e; }
  expect(rejected, message ?? "expected the promise to reject").toBe(true);
  check(error, matcher, message);
}
