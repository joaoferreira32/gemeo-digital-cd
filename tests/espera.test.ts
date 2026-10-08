import { describe, expect, it } from 'vitest';
import { Recorder } from '../src/sim/recorder';
import { World } from '../src/sim/world';

const SECOND = 60;

/** Cycle and waiting time of every delivery after `from` seconds. */
function deliveries(w: World, from = 60) {
  const rows: { cycle: number; waited: number; rack: boolean }[] = [];
  w.onDelivery = (p) => {
    if (w.time > from)
      rows.push({ cycle: w.time - p.createdAt, waited: p.waited, rack: p.origin < 0 });
  };
  return rows;
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('waiting time of a packet (the part of its cycle spent not moving)', () => {
  it('is between nothing and the whole cycle, for every delivery', () => {
    const w = new World({ seed: 11 });
    const rows = deliveries(w);
    w.stepMany(240 * SECOND);
    expect(rows.filter((r) => !r.rack).length).toBeGreaterThan(400);
    expect(rows.filter((r) => r.rack).length).toBeGreaterThan(50);
    // A stock order waits on its shelf until a robot loads it.
    expect(mean(rows.filter((r) => r.rack).map((r) => r.waited))).toBeGreaterThan(5);
    for (const r of rows) {
      expect(r.waited).toBeGreaterThanOrEqual(0);
      expect(r.waited).toBeLessThanOrEqual(r.cycle + 1e-9);
    }
  }, 30_000);

  it('almost none in an empty building, most of the cycle behind a broken belt', () => {
    const empty = new World({ seed: 11, arrivalRate: 0.3 });
    const calm = deliveries(empty);
    empty.stepMany(240 * SECOND);
    const inbound = calm.filter((r) => !r.rack);
    expect(mean(inbound.map((r) => r.waited)) / mean(inbound.map((r) => r.cycle))).toBeLessThan(
      0.05,
    );
    const jammed = new World({ seed: 11 });
    jammed.setConveyorStatus(8, 'broken');
    const rows = deliveries(jammed);
    jammed.stepMany(240 * SECOND);
    const stuck = rows.filter((r) => !r.rack);
    expect(mean(stuck.map((r) => r.waited)) / mean(stuck.map((r) => r.cycle))).toBeGreaterThan(0.4);
  }, 30_000);

  it('the time in the entry pile counts when the packet enters its first belt', () => {
    const w = new World({ seed: 5, arrivalRate: 8 });
    let checked = 0;
    for (let i = 0; i < 60 * SECOND && checked < 20; i++) {
      const heads = w.inbounds.map((inbound) => inbound.backlog[0]);
      w.step();
      for (const p of heads) {
        if (p?.state !== 'conveyor') continue;
        // Inducted in this step, after the belts moved: only the pile so far.
        expect(p.waited).toBe(w.time - p.createdAt);
        checked++;
      }
    }
    expect(checked).toBe(20);
  });

  it('on a stopped belt, every packet waits the whole time', () => {
    const w = new World({ seed: 3 });
    w.stepMany(60 * SECOND);
    const belt = w.conveyors.find((c) => c.packets.length >= 3)!;
    w.setConveyorStatus(belt.edgeId, 'broken');
    const before = new Map(belt.packets.map((p) => [p, p.waited]));
    w.stepMany(5 * SECOND);
    for (const [p, waited] of before) {
      if (p.edge !== belt.edgeId) continue;
      expect(p.waited - waited).toBeCloseTo(5, 9);
    }
  });

  it('waiting for a robot to carry it around a stopped belt counts too', () => {
    const w = new World({ seed: 3 });
    w.stepMany(30 * SECOND);
    w.setConveyorStatus(8, 'broken');
    const lane = w.lanes.find((l) => l.edgeId === 8)!;
    for (let i = 0; i < 60 * SECOND && lane.pickup.length === 0; i++) w.step();
    const p = lane.pickup[0]!;
    const waited = p.waited;
    let steps = 0;
    while (lane.pickup.includes(p) && steps < 10 * SECOND) {
      w.step();
      steps++;
    }
    expect(steps).toBeGreaterThan(0);
    // Each step it stayed in the buffer counted; the step it was picked up, too.
    expect(p.waited - waited).toBeCloseTo(steps / SECOND, 9);
  }, 30_000);

  it('a world restored from a checkpoint goes on with the same waiting times', () => {
    const live = new World({ seed: 7 });
    live.stepMany(95 * SECOND);
    const cp = live.saveState();
    const a = deliveries(live, 0);
    live.stepMany(90 * SECOND);
    const restored = new World({ seed: 7 });
    restored.loadState(cp);
    const b = deliveries(restored, 0);
    restored.stepMany(90 * SECOND);
    expect(b.length).toBeGreaterThan(100);
    expect(b).toEqual(a);
  }, 30_000);

  it('going back in time and on from there keeps each wait with its cycle', () => {
    const rec = new Recorder({ seed: 4 });
    rec.stepMany(150 * SECOND);
    rec.seek(90 * SECOND);
    rec.input({ type: 'stress', on: true });
    rec.stepMany(30 * SECOND);
    const s = rec.series;
    expect(s.waits.length).toBe(s.cycles.length);
    expect(s.cycles.length).toBe(s.cycleEnd.get(s.seconds - 1));
  }, 30_000);

  it('the panel K reads it from the recording, beside the cycle', () => {
    const rec = new Recorder({ seed: 4 });
    rec.stepMany(200 * SECOND);
    const k = rec.kpis(200, 120);
    const s = rec.series;
    const waits = Array.from(s.waits.data.subarray(s.cycleEnd.get(80), s.cycleEnd.get(200)));
    expect(waits.length).toBe(k.deliveries);
    expect(k.waitP95).toBe([...waits].sort((x, y) => x - y)[Math.ceil(0.95 * waits.length) - 1]);
    expect(k.waitMean).toBeCloseTo(mean(waits), 4);
    expect(k.waitP95).toBeLessThan(k.cycleP95);
  }, 30_000);
});
