/**
 * Where a packet is in its life cycle:
 *  - backlog:  created by the inbound order generator, waiting to enter the conveyor;
 *  - rack:     a stock order waiting on its rack shelf for a robot;
 *  - conveyor: on a conveyor lane (`edge`, `s`);
 *  - bypass:   in the buffer of a robot bypass around a broken conveyor;
 *  - robot:    carried by a robot;
 *  - staged:   sorted to its dock, waiting on the staging area for a truck ("delivered").
 * Once loaded into a truck the packet leaves the simulation and is only counted.
 */
export type PacketState = 'backlog' | 'rack' | 'conveyor' | 'bypass' | 'robot' | 'staged';

export interface Packet {
  readonly id: number;
  /** Inbound node where it entered. */
  readonly origin: number;
  /** Dock node it must reach. */
  readonly destination: number;
  /** Simulation time of creation, in seconds. */
  readonly createdAt: number;
  state: PacketState;
  /** Conveyor edge id while on a conveyor, -1 otherwise. */
  edge: number;
  /** Arc length along the current edge, in meters. */
  s: number;
  /** `s` at the previous step, used by the renderer to interpolate between steps. */
  prevS: number;
  /** True when it could not move at full speed during the last step (it is queuing). */
  blocked: boolean;
  /** Simulation time when it reached the dock staging area, -1 before that. */
  deliveredAt: number;
  /** Belt chosen at the junction the packet waits at (-1 until chosen; cleared when it moves). */
  next: number;
  /**
   * Seconds spent waiting so far: in the entry pile, on a shelf or in a bypass
   * buffer waiting for a robot, and on a belt whenever it could not move at the
   * belt's speed (the time lost against moving freely; all of it while the belt
   * is stopped). Being carried by a robot counts as moving. A measure only:
   * nothing in the simulation reads it.
   */
  waited: number;
}

export function createPacket(
  id: number,
  origin: number,
  destination: number,
  createdAt: number,
): Packet {
  return {
    id,
    origin,
    destination,
    createdAt,
    state: 'backlog',
    edge: -1,
    s: 0,
    prevS: 0,
    blocked: true,
    deliveredAt: -1,
    next: -1,
    waited: 0,
  };
}
