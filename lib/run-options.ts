/**
 * Fail closed: an invalid limit must never silently become an unlimited run.
 * Explicit MAX_BOOKS=0 opts into processing the entire pending library.
 */
export function parseMaxBooks(value: string | undefined): number {
  if (value === undefined) return 1;
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Invalid MAX_BOOKS. Use a non-negative integer (0 = unlimited, default = 1).');
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) {
    throw new Error('MAX_BOOKS is too large to represent safely.');
  }
  return limit;
}
