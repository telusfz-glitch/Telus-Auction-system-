export interface RefreshTimers {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
  random: () => number;
}

export interface RefreshOptions {
  /** Delay for events about this customer (outbid, leading, auction opened/closed): shown almost at once. */
  urgentMs: number;
  /** At most one refresh per this interval for broadcast price changes, which every spectator receives. */
  minIntervalMs: number;
  /** Random extra delay for broadcast refreshes, so thousands of browsers do not hit the server in the same instant. */
  jitterMs: number;
}

const DEFAULTS: RefreshOptions = { urgentMs: 150, minIntervalMs: 2000, jitterMs: 1000 };
const REAL: RefreshTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (t) => globalThis.clearTimeout(t as ReturnType<typeof setTimeout>),
  random: Math.random,
};

/**
 * Decides when an auction page re-renders from the server after push events. Every refresh costs the web server a page
 * render and the API several queries, and a price change in a 'full_price' auction reaches EVERY spectator: refreshing
 * each browser on each bid would multiply load by (bids × spectators). Pending refreshes coalesce (only the earliest
 * scheduled one runs), broadcast ones are rate-limited per browser and spread out, own-position ones stay prompt.
 */
export function createRefreshScheduler(run: () => void, options: Partial<RefreshOptions> = {}, timers: RefreshTimers = REAL) {
  const o = { ...DEFAULTS, ...options };
  let timer: unknown;
  let dueAt = Infinity;
  let lastRun = -Infinity;

  const at = (delayMs: number) => {
    const due = timers.now() + delayMs;
    if (timer !== undefined && due >= dueAt) return;   // an earlier refresh is already coming and will include this
    if (timer !== undefined) timers.clearTimeout(timer);
    dueAt = due;
    timer = timers.setTimeout(() => {
      timer = undefined;
      dueAt = Infinity;
      lastRun = timers.now();
      run();
    }, delayMs);
  };

  return {
    urgent: () => at(o.urgentMs),
    broadcast: () => at(Math.max(o.urgentMs, lastRun + o.minIntervalMs - timers.now()) + Math.floor(timers.random() * o.jitterMs)),
    cancel: () => { if (timer !== undefined) timers.clearTimeout(timer); timer = undefined; dueAt = Infinity; },
  };
}
