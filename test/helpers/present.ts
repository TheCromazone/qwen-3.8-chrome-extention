/** Narrows a nullable value, failing the test with a useful message instead of a TypeError. */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what} to be present, got ${String(value)}`);
  return value;
}
