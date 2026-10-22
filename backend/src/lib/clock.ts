/**
 * The one source of "now" for every exam/attempt/invite decision (deadlines, windows, release times, expiry).
 * It is the SERVER clock; the browser's clock is never consulted. Tests replace it with `setClock`.
 */
let source: () => Date = () => new Date();

export const now = (): Date => source();

/** Test helper: pass a function (or null to restore the real clock). */
export function setClock(fn: (() => Date) | null): void {
  source = fn ?? (() => new Date());
}
