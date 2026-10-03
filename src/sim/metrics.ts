/**
 * Delivery metrics. Totals are cumulative; the windowed figures cover the
 * last `windowSeconds` of simulation time so the HUD reacts to what is
 * happening now instead of averaging the whole run.
 */
import type { StateReader, StateWriter } from './state';

export class Metrics {
  created = 0;
  delivered = 0;
  /** Deliveries made by robots (stock orders taken straight to a dock). */
  deliveredByRobots = 0;
  shipped = 0;
  /** Packets that reached a dock other than their destination (must stay 0). */
  misrouted = 0;
  private cycleSum = 0;

  // Ring of (delivery time, cycle time) inside the window.
  private times: number[] = [];
  private cycles: number[] = [];
  private head = 0;
  private windowCycleSum = 0;

  constructor(readonly windowSeconds: number) {}

  recordDelivery(now: number, cycleTime: number): void {
    this.delivered++;
    this.cycleSum += cycleTime;
    this.times.push(now);
    this.cycles.push(cycleTime);
    this.windowCycleSum += cycleTime;
  }

  /** Drops deliveries older than the window. Called once per step. */
  evict(now: number): void {
    const cutoff = now - this.windowSeconds;
    while (this.head < this.times.length && (this.times[this.head] as number) < cutoff) {
      this.windowCycleSum -= this.cycles[this.head] as number;
      this.head++;
    }
    // Compact occasionally so the arrays do not grow forever.
    // Compaction only frees memory: the window sum is never recomputed, so a
    // world restored from a checkpoint (which compacts at other moments) keeps
    // exactly the same values.
    if (this.head > 4096 && this.head * 2 > this.times.length) {
      this.times = this.times.slice(this.head);
      this.cycles = this.cycles.slice(this.head);
      this.head = 0;
    }
  }

  save(w: StateWriter): void {
    w.int(this.created);
    w.int(this.delivered);
    w.int(this.deliveredByRobots);
    w.int(this.shipped);
    w.int(this.misrouted);
    w.float(this.cycleSum);
    w.float(this.windowCycleSum);
    w.floats64(this.times.slice(this.head));
    w.floats64(this.cycles.slice(this.head));
  }

  load(r: StateReader): void {
    this.created = r.int();
    this.delivered = r.int();
    this.deliveredByRobots = r.int();
    this.shipped = r.int();
    this.misrouted = r.int();
    this.cycleSum = r.float();
    this.windowCycleSum = r.float();
    this.times = r.floats64();
    this.cycles = r.floats64();
    this.head = 0;
  }

  /** Mean time in system over all deliveries, in seconds (NaN before the first one). */
  /** Cycle times of the last `n` deliveries (still inside the window), oldest first. */
  lastCycles(n: number): number[] {
    const from = Math.max(this.head, this.cycles.length - n);
    return this.cycles.slice(from);
  }

  get meanCycleTime(): number {
    return this.delivered > 0 ? this.cycleSum / this.delivered : NaN;
  }

  get windowDeliveries(): number {
    return this.times.length - this.head;
  }

  /** Mean time in system of the deliveries inside the window (NaN when there are none). */
  get windowMeanCycleTime(): number {
    const n = this.windowDeliveries;
    return n > 0 ? this.windowCycleSum / n : NaN;
  }

  /** Deliveries per minute inside the window (runs shorter than the window use the elapsed time). */
  throughputPerMinute(now: number): number {
    const span = Math.min(now, this.windowSeconds);
    return span > 0 ? (this.windowDeliveries / span) * 60 : 0;
  }
}
