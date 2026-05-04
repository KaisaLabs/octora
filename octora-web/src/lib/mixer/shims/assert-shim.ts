// Minimal browser shim for Node's `assert` module, used transitively by
// circomlibjs' Poseidon implementations. circomlibjs only calls assert for
// input-shape validation; in normal flow we always pass valid inputs.
//
// Provides assert(value, msg) (the bare call form) and the few methods
// circomlibjs actually uses. Anything missing throws a clear error so we
// notice if the surface ever expands.

type AssertFn = ((value: unknown, message?: string) => asserts value) & {
  equal(actual: unknown, expected: unknown, message?: string): void;
  notEqual(actual: unknown, expected: unknown, message?: string): void;
  strictEqual(actual: unknown, expected: unknown, message?: string): void;
  ok(value: unknown, message?: string): asserts value;
};

const fn = ((value: unknown, message?: string) => {
  if (!value) throw new Error(message ?? "Assertion failed");
}) as AssertFn;

fn.equal = (a, b, m) => {
  // eslint-disable-next-line eqeqeq
  if (a != b) throw new Error(m ?? `Expected ${String(a)} == ${String(b)}`);
};
fn.notEqual = (a, b, m) => {
  // eslint-disable-next-line eqeqeq
  if (a == b) throw new Error(m ?? `Expected ${String(a)} != ${String(b)}`);
};
fn.strictEqual = (a, b, m) => {
  if (a !== b) throw new Error(m ?? `Expected ${String(a)} === ${String(b)}`);
};
fn.ok = (value, message) => {
  if (!value) throw new Error(message ?? "Assertion failed");
};

export default fn;
export const equal = fn.equal;
export const notEqual = fn.notEqual;
export const strictEqual = fn.strictEqual;
export const ok = fn.ok;
