/**
 * Delivery metrics. Totals are cumulative; the windowed figures cover the
 * last `windowSeconds` of simulation time so the HUD reacts to what is
 * happening now instead of averaging the whole run.
 */
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
    if (this.head > 4096 && this.head * 2 > this.times.length) {
      this.times = this.times.slice(this.head);
      this.cycles = this.cycles.slice(this.head);
      this.head = 0;
      this.windowCycleSum = this.cycles.reduce((a, b) => a + b, 0);
    }
  }

  /** Mean time in system over all deliveries, in seconds (NaN before the first one). */
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
