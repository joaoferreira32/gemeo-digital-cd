import { describe, expect, it } from 'vitest';
import {
  advanceConveyor,
  canAccept,
  conveyorCapacity,
  createConveyor,
  popHead,
  pushPacket,
  readyHead,
} from '../src/sim/conveyor';
import { createPacket } from '../src/sim/packet';

const DT = 1 / 60;

function fill(length: number, count: number, stepsBetween: number) {
  const c = createConveyor(0, length, 1, 0.5);
  let id = 1;
  for (let i = 0; i < count; i++) {
    if (canAccept(c)) pushPacket(c, createPacket(id++, 0, 1, 0));
    for (let k = 0; k < stepsBetween; k++) advanceConveyor(c, DT);
  }
  return c;
}

describe('Conveyor', () => {
  it('moves packets at belt speed', () => {
    const c = createConveyor(0, 10, 2, 0.5);
    pushPacket(c, createPacket(1, 0, 1, 0));
    for (let i = 0; i < 60; i++) advanceConveyor(c, DT);
    expect(c.packets[0]!.s).toBeCloseTo(2, 9);
    expect(c.packets[0]!.blocked).toBe(false);
  });

  it('stops the head at the end and queues the others at minimum spacing', () => {
    const c = fill(5, 200, 40);
    expect(c.packets.length).toBe(conveyorCapacity(c));
    expect(c.packets[0]!.s).toBe(5);
    for (let i = 1; i < c.packets.length; i++) {
      const gap = c.packets[i - 1]!.s - c.packets[i]!.s;
      expect(gap).toBeGreaterThanOrEqual(c.spacing - 1e-9);
    }
    expect(canAccept(c)).toBe(false);
    advanceConveyor(c, DT);
    expect(c.packets.every((p) => p.blocked)).toBe(true);
  });

  it('never moves a packet backwards or past the one ahead', () => {
    const c = fill(8, 400, 3);
    for (let step = 0; step < 600; step++) {
      if (step % 7 === 0 && readyHead(c)) popHead(c);
      advanceConveyor(c, DT);
      for (let i = 0; i < c.packets.length; i++) {
        const p = c.packets[i]!;
        expect(p.s).toBeGreaterThanOrEqual(p.prevS);
        if (i > 0) expect(c.packets[i - 1]!.s - p.s).toBeGreaterThanOrEqual(c.spacing - 1e-9);
      }
    }
  });

  it('freezes everything while broken and refuses new packets', () => {
    const c = fill(10, 3, 30);
    const before = c.packets.map((p) => p.s);
    c.status = 'broken';
    for (let i = 0; i < 120; i++) advanceConveyor(c, DT);
    expect(c.packets.map((p) => p.s)).toEqual(before);
    expect(c.packets.every((p) => p.blocked)).toBe(true);
    expect(canAccept(c)).toBe(false);
    c.status = 'ok';
    advanceConveyor(c, DT);
    expect(c.packets[0]!.s).toBeGreaterThan(before[0]!);
  });

  it('keeps FIFO order', () => {
    const c = fill(4, 50, 20);
    const out: number[] = [];
    for (let i = 0; i < 3000; i++) {
      advanceConveyor(c, DT);
      const head = readyHead(c);
      if (head) out.push(popHead(c).id);
    }
    expect(out).toEqual([...out].sort((a, b) => a - b));
    expect(out.length).toBeGreaterThan(0);
  });
});
