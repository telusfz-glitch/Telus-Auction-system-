import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRefreshScheduler } from '../src/lib/refresh-scheduler';

describe('auction page refresh scheduling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const timers = (random = 0.5) => ({
    now: () => Date.now(), setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
    clearTimeout: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>), random: () => random,
  });

  it('a busy full-price auction (5 bids/s for 60 s) re-renders each browser at most every ~2 s, not 300 times', () => {
    const run = vi.fn();
    const s = createRefreshScheduler(run, {}, timers());
    for (let i = 0; i < 300; i++) { s.broadcast(); vi.advanceTimersByTime(200); }
    vi.advanceTimersByTime(5000);
    expect(run.mock.calls.length).toBeLessThanOrEqual(25);   // ≈ 60 s / 2.5 s
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(20); // still keeps up
  });

  it('events about this customer (outbid, leading) show within 150 ms, even right after a refresh', () => {
    const run = vi.fn();
    const s = createRefreshScheduler(run, {}, timers());
    s.urgent(); vi.advanceTimersByTime(150); expect(run).toHaveBeenCalledTimes(1);
    s.broadcast();                        // throttled: would run ~2.5 s later
    vi.advanceTimersByTime(100); s.urgent();
    vi.advanceTimersByTime(150); expect(run).toHaveBeenCalledTimes(2);   // the urgent one replaced the later refresh
    vi.advanceTimersByTime(5000); expect(run).toHaveBeenCalledTimes(2);  // and covered it: no extra render
  });

  it('spreads browsers over the jitter window instead of all refreshing at the same instant', () => {
    const runA = vi.fn(), runB = vi.fn();
    createRefreshScheduler(runA, {}, timers(0)).broadcast();
    createRefreshScheduler(runB, {}, timers(0.99)).broadcast();
    vi.advanceTimersByTime(200); expect(runA).toHaveBeenCalledTimes(1); expect(runB).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); expect(runB).toHaveBeenCalledTimes(1);
  });

  it('cancel stops a pending refresh (page left)', () => {
    const run = vi.fn();
    const s = createRefreshScheduler(run, {}, timers());
    s.urgent(); s.cancel(); vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
  });
});
