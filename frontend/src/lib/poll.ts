/**
 * Sequential polling with no overlap and no tight loops: the next request is scheduled only after the previous one finished.
 * It keeps going only while `keepGoing(data)` is true, skips the request (but keeps the timer) while the tab is hidden, and backs off
 * after errors. Returns a stop function; stopping also cancels a pending timer, so an unmounted component is never called.
 */
export function startPolling<T>(opts: {
  load: () => Promise<T>;
  onData: (data: T) => void;
  keepGoing: (data: T) => boolean;
  intervalMs?: number;
  maxBackoffMs?: number;
  visible?: () => boolean;
}): () => void {
  const base = opts.intervalMs ?? 3000;
  const maxBackoff = opts.maxBackoffMs ?? 30_000;
  const visible = opts.visible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  const schedule = () => {
    if (stopped) return;
    const delay = failures ? Math.min(maxBackoff, base * 2 ** failures) : base;
    timer = setTimeout(tick, delay);
  };
  async function tick() {
    if (stopped) return;
    if (!visible()) return schedule();
    try {
      const data = await opts.load();
      if (stopped) return;
      failures = 0;
      opts.onData(data);
      if (!opts.keepGoing(data)) return void (stopped = true);
    } catch {
      failures = Math.min(failures + 1, 6);
    }
    schedule();
  }
  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
