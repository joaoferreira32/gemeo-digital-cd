import { describe, expect, it } from 'vitest';
import { FrameBuffer, decodeFrame, type SimFrame } from '../src/link/frames';
import {
  HEADER,
  PACKET_STRIDE,
  ROBOT,
  ROBOT_STRIDE,
  STAGES,
  SnapshotWriter,
  readSnapshot,
} from '../src/sim/snapshot';
import { World } from '../src/sim/world';
import { SimHost } from '../src/worker/host';
import type { SimMessage } from '../src/worker/protocol';

describe('SnapshotWriter / readSnapshot', () => {
  it('round-trips the world state through one buffer', () => {
    const w = new World({ seed: 4 });
    w.stepMany(90 * 60);
    const writer = new SnapshotWriter(w);
    const s = readSnapshot(writer.write({ speed: 4, stress: false }));
    expect(s.header[HEADER.tick]).toBe(w.tick);
    expect(s.header[HEADER.delivered]).toBe(w.metrics.delivered);
    expect(s.header[HEADER.speed]).toBe(4);
    expect(s.header[HEADER.packets]).toBe(w.stats.onConveyors);
    expect(s.header[HEADER.robots]).toBe(40);
    const r = w.fleet!.robots[3]!;
    const o = 3 * ROBOT_STRIDE;
    expect(s.robots[o + ROBOT.x1]).toBeCloseTo(r.motion.x, 4);
    expect(s.robots[o + ROBOT.z1]).toBeCloseTo(r.motion.z, 4);
    expect(STAGES[s.robots[o + ROBOT.stage]!]).toBe(r.stage);
    expect(s.robots[o + ROBOT.battery]).toBeCloseTo(r.battery, 3);
    expect(s.inbounds[0]).toBe(w.inbounds[0]!.backlog.length);
    expect(s.docks[0]).toBe(w.docks[0]!.staged.length);
  });

  it('carries the previous pose so consecutive snapshots join up exactly', () => {
    const w = new World({ seed: 4 });
    w.stepMany(60 * 60);
    const writer = new SnapshotWriter(w);
    const a = readSnapshot(writer.write({ speed: 1, stress: false }));
    w.stepMany(3);
    const b = readSnapshot(writer.write({ speed: 1, stress: false }));
    const posA = new Map<number, [number, number]>();
    for (let i = 0; i < a.packetIds.length; i++) {
      posA.set(a.packetIds[i]!, [
        a.packets[i * PACKET_STRIDE + 3]!,
        a.packets[i * PACKET_STRIDE + 4]!,
      ]);
    }
    let checked = 0;
    for (let i = 0; i < b.packetIds.length; i++) {
      const prev = posA.get(b.packetIds[i]!);
      if (!prev) continue;
      expect(b.packets[i * PACKET_STRIDE]).toBe(prev[0]);
      expect(b.packets[i * PACKET_STRIDE + 1]).toBe(prev[1]);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
    expect(b.header[HEADER.prevTime]).toBe(a.header[HEADER.time]);
    for (let k = 0; k < 40; k++) {
      expect(b.robots[k * ROBOT_STRIDE + ROBOT.x0]).toBe(a.robots[k * ROBOT_STRIDE + ROBOT.x1]);
    }
  });

  it('reuses recycled buffers instead of allocating a new one per snapshot', () => {
    const w = new World({ seed: 4 });
    w.stepMany(60 * 60);
    const writer = new SnapshotWriter(w);
    for (let i = 0; i < 200; i++) {
      w.step();
      writer.recycle(writer.write({ speed: 1, stress: false }));
    }
    expect(writer.allocations).toBeLessThanOrEqual(2);
  });

  it('reports each event exactly once', () => {
    const w = new World({ seed: 4 });
    const writer = new SnapshotWriter(w);
    w.failures.inject('robot', 0, 2);
    expect(writer.newEvents().map((e) => e.text)).toEqual(['Robô 3 com defeito']);
    expect(writer.newEvents()).toEqual([]);
  });
});

describe('SimHost', () => {
  function makeHost() {
    let now = 0;
    const posted: SimMessage[] = [];
    const host = new SimHost(
      (msg) => posted.push(msg),
      () => now,
    );
    return { host, posted, tick: (ms: number) => (now += ms) };
  }

  it('advances simulated time with the real clock times the speed', () => {
    const { host, posted, tick } = makeHost();
    host.handle({ type: 'init', config: { seed: 3 } });
    for (let i = 0; i < 60; i++) {
      tick(16);
      host.pump();
    }
    expect(host.currentWorld.time).toBeCloseTo(0.96, 1);
    host.handle({ type: 'speed', speed: 4 });
    const t0 = host.currentWorld.time;
    for (let i = 0; i < 60; i++) {
      tick(16);
      host.pump();
    }
    expect(host.currentWorld.time - t0).toBeCloseTo(3.84, 1);
    expect(posted.every((m) => m.type === 'snapshot')).toBe(true);
  });

  it('does not advance while paused and still answers commands', () => {
    const { host, posted, tick } = makeHost();
    host.handle({ type: 'speed', speed: 0 });
    const before = posted.length;
    tick(500);
    host.pump();
    expect(host.currentWorld.tick).toBe(0);
    host.handle({ type: 'inject', kind: 'conveyor', target: 1 });
    expect(posted.length).toBe(before + 1);
    const last = posted.at(-1)!;
    expect(last.type === 'snapshot' && last.events.map((e) => e.text)).toEqual([
      'Esteira 2 (A1→A2) quebrou',
    ]);
  });

  it('caps the backlog when it cannot keep up instead of spiralling', () => {
    const { host, tick } = makeHost();
    host.handle({ type: 'speed', speed: 16 });
    tick(10_000); // a long stall (tab in background)
    host.pump();
    // At most 0.25 s of real time is honored per pump, and the backlog is capped.
    expect(host.currentWorld.time).toBeLessThanOrEqual(0.5 + 1 / 60 + 1e-9);
  });

  it('restarts with the same seed and applies the load test', () => {
    const { host } = makeHost();
    host.handle({ type: 'init', config: { seed: 8 } });
    host.handle({ type: 'advance', seconds: 30 });
    expect(host.currentWorld.time).toBeCloseTo(30, 6);
    host.handle({ type: 'stress', on: true });
    expect(host.currentWorld.currentArrivalRate).toBe(40);
    host.handle({ type: 'restart' });
    expect(host.currentWorld.time).toBe(0);
    expect(host.currentWorld.config.seed).toBe(8);
    expect(host.currentWorld.currentArrivalRate).toBe(40);
  });
});

describe('FrameBuffer', () => {
  function frames() {
    const w = new World({ seed: 4, robots: 0 });
    const writer = new SnapshotWriter(w);
    const out: SimFrame[] = [];
    for (let i = 0; i < 6; i++) {
      w.stepMany(2);
      out.push(decodeFrame(writer.write({ speed: 1, stress: false }), []));
    }
    return out;
  }

  it('draws one interval behind the newest snapshot and interpolates inside it', () => {
    const released: ArrayBuffer[] = [];
    const fb = new FrameBuffer((b) => released.push(b), 4);
    const fs = frames();
    for (const f of fs) fb.push(f);
    expect(released).toHaveLength(2); // capacity 4 out of 6
    fb.advance(0);
    for (let i = 0; i < 200; i++) fb.advance(1 / 60 / 10);
    const last = fs.at(-1)!;
    expect(fb.renderTime).toBeLessThanOrEqual(last.time);
    expect(fb.renderTime).toBeGreaterThanOrEqual(last.prevTime - 1e-9);
    const { frame, alpha } = fb.sample()!;
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(alpha).toBeLessThanOrEqual(1);
    expect(frame.prevTime - 1e-9).toBeLessThanOrEqual(fb.renderTime);
  });

  it('clears everything on a restart (time going backwards)', () => {
    const released: ArrayBuffer[] = [];
    const fb = new FrameBuffer((b) => released.push(b), 4);
    const fs = frames();
    fb.push(fs[3]!);
    fb.push(fs[4]!);
    fb.push(fs[0]!); // older time = new world
    expect(released).toEqual([fs[3]!.buffer, fs[4]!.buffer]);
    expect(fb.latest).toBe(fs[0]);
  });
});
