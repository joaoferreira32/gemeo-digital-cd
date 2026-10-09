import type { Packet } from './packet';

/** `maintenance`: stopped for a planned maintenance (schedule.ts), not broken. */
export type ConveyorStatus = 'ok' | 'broken' | 'maintenance';

/**
 * A conveyor is a 1D lane: each packet has an arc-length position `s` in
 * [0, length]. Packets keep a minimum center-to-center `spacing`, so the
 * lane throughput is at most speed / spacing and a stopped head packet makes
 * the ones behind it queue up — queues are an emergent property, not a counter.
 */
export interface Conveyor {
  readonly edgeId: number;
  readonly length: number;
  readonly spacing: number;
  speed: number;
  status: ConveyorStatus;
  /** Packets ordered front (closest to the end) to back. */
  readonly packets: Packet[];
}

export function createConveyor(
  edgeId: number,
  length: number,
  speed: number,
  spacing: number,
): Conveyor {
  return { edgeId, length, speed, spacing, status: 'ok', packets: [] };
}

/** Maximum number of packets the lane can hold at minimum spacing. */
export function conveyorCapacity(c: Conveyor): number {
  return Math.floor(c.length / c.spacing) + 1;
}

/** A stopped (broken) belt cannot take packets in; a running one needs room at its entry. */
export function canAccept(c: Conveyor): boolean {
  if (c.status !== 'ok') return false;
  const last = c.packets[c.packets.length - 1];
  return last === undefined || last.s >= c.spacing;
}

/** Places a packet at the entry of the lane. Caller must check `canAccept` first. */
export function pushPacket(c: Conveyor, p: Packet): void {
  p.edge = c.edgeId;
  p.state = 'conveyor';
  p.s = 0;
  p.prevS = 0;
  p.blocked = false;
  p.next = -1;
  c.packets.push(p);
}

/** The front packet when it has reached the end of the lane, otherwise undefined. */
export function readyHead(c: Conveyor): Packet | undefined {
  const head = c.packets[0];
  return head !== undefined && head.s >= c.length ? head : undefined;
}

export function popHead(c: Conveyor): Packet {
  const head = c.packets.shift();
  if (!head) throw new Error(`Conveyor ${c.edgeId} is empty`);
  head.edge = -1;
  return head;
}

/** Moves every packet forward by one time step, respecting the end of the lane and spacing. */
export function advanceConveyor(c: Conveyor, dt: number): void {
  const v = c.status === 'ok' ? c.speed : 0;
  const perMeter = v > 0 ? 1 / v : 0;
  let limit = c.length;
  for (const p of c.packets) {
    p.prevS = p.s;
    const wanted = p.s + v * dt;
    const next = Math.max(p.s, Math.min(wanted, limit));
    // Blocked = waiting: the belt is stopped or the packet could not travel the full step.
    const blocked = v === 0 || next < wanted - 1e-9;
    p.blocked = blocked;
    // The time lost against moving at the belt's speed (all of it while the belt is
    // stopped). A packet that moved the full step lost none: only blocked ones add.
    if (blocked) p.waited += v > 0 ? dt - (next - p.s) * perMeter : dt;
    p.s = next;
    limit = next - c.spacing;
  }
}
