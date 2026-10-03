import { pointOnEdge, type EdgePoint } from './graph';
import type { SimEvent } from './failures';
import { ROBOT_STAGES, type RobotStage } from './fleet';
import type { World } from './world';

/**
 * Binary snapshot of the world, written by the simulation worker and read by
 * the renderer. One ArrayBuffer per snapshot, transferred (not copied) to the
 * main thread and handed back for reuse.
 *
 * Every moving thing carries two poses: where it was at the previous snapshot
 * and where it is now, so the renderer interpolates between them without
 * knowing anything about conveyors or plans.
 */

export const HEADER = {
  tick: 0,
  time: 1,
  prevTime: 2,
  speed: 3,
  created: 4,
  delivered: 5,
  shipped: 6,
  waiting: 7,
  backlog: 8,
  onConveyors: 9,
  staged: 10,
  windowCycle: 11,
  throughput: 12,
  packets: 13,
  robots: 14,
  routeCells: 15,
  inBypass: 16,
  onRobots: 17,
  rackPending: 18,
  deliveredByRobots: 19,
  arrivalRate: 20,
  autoFailures: 21,
  conveyors: 22,
  docks: 23,
  lanes: 24,
  inbounds: 25,
  failures: 26,
  robotsWorking: 27,
  robotsCharging: 28,
  robotsIdle: 29,
  robotsDefect: 30,
  plans: 31,
  failedPlans: 32,
  bumps: 33,
  jobsDone: 34,
  rackOrders: 35,
  stress: 36,
  seed: 37,
  stepSeconds: 38,
} as const;
export const HEADER_LEN = 40;

/** Floats per entry in each section. */
export const PACKET_STRIDE = 8; // x0 z0 h0 x1 z1 h1 waitSeconds dockIndex
export const ROBOT_STRIDE = 16;
export const ROBOT = {
  x0: 0,
  z0: 1,
  h0: 2,
  x1: 3,
  z1: 4,
  h1: 5,
  stage: 6,
  battery: 7,
  load: 8,
  speed: 9,
  job: 10,
  station: 11,
  routeOffset: 12,
  routeLength: 13,
  planEnd: 14,
  waiting: 15,
} as const;
export const DOCK_STRIDE = 6; // staged truckState awayLeft truckLoad blocked blockedLeft
export const LANE_STRIDE = 4; // active pickup drop carried
export const FAILURE_STRIDE = 5; // kind target startedAt endsAt id
export const CONVEYOR_STRIDE = 2; // status blocked

export const STAGES: readonly RobotStage[] = ROBOT_STAGES;
export const JOBS = ['none', 'rack', 'bypass', 'charge', 'park', 'goto'] as const;
export const TRUCK_STATES = ['docked', 'loading', 'away'] as const;
export const FAILURE_KINDS = ['conveyor', 'surge', 'robot', 'dock'] as const;

export interface SnapshotSections {
  header: Float64Array;
  packets: Float32Array;
  packetIds: Uint32Array;
  robots: Float32Array;
  docks: Float32Array;
  inbounds: Float32Array;
  lanes: Float32Array;
  failures: Float32Array;
  conveyors: Float32Array;
  /** (x, z) pairs of the remaining route cells of every robot. */
  routes: Int16Array;
}

interface Counts {
  packets: number;
  robots: number;
  routeCells: number;
  docks: number;
  inbounds: number;
  lanes: number;
  failures: number;
  conveyors: number;
}

function layoutOf(c: Counts): { offsets: Record<keyof SnapshotSections, number>; bytes: number } {
  let off = 0;
  const take = (bytes: number, align: number) => {
    off = Math.ceil(off / align) * align;
    const at = off;
    off += bytes;
    return at;
  };
  const offsets = {
    header: take(HEADER_LEN * 8, 8),
    packets: take(c.packets * PACKET_STRIDE * 4, 4),
    packetIds: take(c.packets * 4, 4),
    robots: take(c.robots * ROBOT_STRIDE * 4, 4),
    docks: take(c.docks * DOCK_STRIDE * 4, 4),
    inbounds: take(c.inbounds * 4, 4),
    lanes: take(c.lanes * LANE_STRIDE * 4, 4),
    failures: take(c.failures * FAILURE_STRIDE * 4, 4),
    conveyors: take(c.conveyors * CONVEYOR_STRIDE * 4, 4),
    routes: take(c.routeCells * 2 * 2, 2),
  };
  return { offsets, bytes: Math.ceil(off / 8) * 8 };
}

function viewsOf(buffer: ArrayBuffer, c: Counts): SnapshotSections {
  const { offsets: o } = layoutOf(c);
  return {
    header: new Float64Array(buffer, o.header, HEADER_LEN),
    packets: new Float32Array(buffer, o.packets, c.packets * PACKET_STRIDE),
    packetIds: new Uint32Array(buffer, o.packetIds, c.packets),
    robots: new Float32Array(buffer, o.robots, c.robots * ROBOT_STRIDE),
    docks: new Float32Array(buffer, o.docks, c.docks * DOCK_STRIDE),
    inbounds: new Float32Array(buffer, o.inbounds, c.inbounds),
    lanes: new Float32Array(buffer, o.lanes, c.lanes * LANE_STRIDE),
    failures: new Float32Array(buffer, o.failures, c.failures * FAILURE_STRIDE),
    conveyors: new Float32Array(buffer, o.conveyors, c.conveyors * CONVEYOR_STRIDE),
    routes: new Int16Array(buffer, o.routes, c.routeCells * 2),
  };
}

/** Reads a snapshot buffer (zero-copy views). */
export function readSnapshot(buffer: ArrayBuffer): SnapshotSections {
  const header = new Float64Array(buffer, 0, HEADER_LEN);
  return viewsOf(buffer, {
    packets: header[HEADER.packets] as number,
    robots: header[HEADER.robots] as number,
    routeCells: header[HEADER.routeCells] as number,
    docks: header[HEADER.docks] as number,
    inbounds: header[HEADER.inbounds] as number,
    lanes: header[HEADER.lanes] as number,
    failures: header[HEADER.failures] as number,
    conveyors: header[HEADER.conveyors] as number,
  });
}

/** Where a tracked thing was at the previous snapshot. */
interface Trace {
  x: number;
  z: number;
  h: number;
  blockedSince: number;
  seen: number;
}

/**
 * Writes snapshots of one World, remembering the previous pose of every
 * packet and robot so each snapshot is self-contained for interpolation.
 */
export class SnapshotWriter {
  private readonly packetTraces = new Map<number, Trace>();
  private readonly robotTraces: Trace[] = [];
  private readonly point: EdgePoint = { x: 0, z: 0, heading: 0 };
  private generation = 0;
  private prevTime: number;
  private lastEventId = 0;
  /** Buffers handed back by the reader, ready to be reused. */
  private readonly pool: ArrayBuffer[] = [];
  allocations = 0;

  constructor(private readonly world: World) {
    this.prevTime = world.time;
  }

  /** Returns a buffer the reader no longer needs. */
  recycle(buffer: ArrayBuffer): void {
    if (this.pool.length < 8) this.pool.push(buffer);
  }

  /** Events emitted since the previous snapshot. */
  newEvents(): SimEvent[] {
    const out = this.world.events.filter((e) => e.id > this.lastEventId);
    if (out.length) this.lastEventId = (out[out.length - 1] as SimEvent).id;
    return out;
  }

  write(extra: { speed: number; stress: boolean }): ArrayBuffer {
    const w = this.world;
    const fleet = w.fleet;
    const now = w.time;
    this.generation++;
    let packetCount = 0;
    for (const c of w.conveyors) packetCount += c.packets.length;
    const robots = fleet?.robots ?? [];
    const step = fleet ? Math.floor(now / fleet.stepSeconds + 1e-9) : 0;
    const routes = robots.map((r) => fleet?.route(r, step, 32) ?? []);
    const routeCells = routes.reduce((n, r) => n + r.length, 0);
    const counts: Counts = {
      packets: packetCount,
      robots: robots.length,
      routeCells,
      docks: w.docks.length,
      inbounds: w.inbounds.length,
      lanes: w.lanes.length,
      failures: w.failures.active.length,
      conveyors: w.conveyors.length,
    };
    const { bytes } = layoutOf(counts);
    let buffer: ArrayBuffer | undefined;
    for (let k = this.pool.length - 1; k >= 0; k--) {
      if ((this.pool[k] as ArrayBuffer).byteLength >= bytes) {
        buffer = this.pool.splice(k, 1)[0] as ArrayBuffer;
        break;
      }
    }
    if (!buffer) {
      // Room to grow, so a slowly rising packet count does not allocate every frame.
      buffer = new ArrayBuffer(Math.ceil((bytes * 1.25) / 4096) * 4096);
      this.allocations++;
    }
    const v = viewsOf(buffer, counts);

    // Header.
    const h = v.header;
    const m = w.metrics;
    const s = w.stats;
    h.fill(0);
    h[HEADER.tick] = w.tick;
    h[HEADER.time] = now;
    h[HEADER.prevTime] = this.prevTime;
    h[HEADER.speed] = extra.speed;
    h[HEADER.created] = m.created;
    h[HEADER.delivered] = m.delivered;
    h[HEADER.shipped] = m.shipped;
    h[HEADER.waiting] = s.waiting;
    h[HEADER.backlog] = s.backlog;
    h[HEADER.onConveyors] = s.onConveyors;
    h[HEADER.staged] = s.staged;
    h[HEADER.windowCycle] = m.windowMeanCycleTime;
    h[HEADER.throughput] = m.throughputPerMinute(now);
    h[HEADER.packets] = counts.packets;
    h[HEADER.robots] = counts.robots;
    h[HEADER.routeCells] = routeCells;
    h[HEADER.inBypass] = s.inBypass;
    h[HEADER.onRobots] = s.onRobots;
    h[HEADER.rackPending] = s.rackPending;
    h[HEADER.deliveredByRobots] = m.deliveredByRobots;
    h[HEADER.arrivalRate] = w.currentArrivalRate;
    h[HEADER.autoFailures] = w.failures.autoEnabled ? 1 : 0;
    h[HEADER.conveyors] = counts.conveyors;
    h[HEADER.docks] = counts.docks;
    h[HEADER.lanes] = counts.lanes;
    h[HEADER.inbounds] = counts.inbounds;
    h[HEADER.failures] = counts.failures;
    h[HEADER.stress] = extra.stress ? 1 : 0;
    h[HEADER.seed] = w.config.seed;
    h[HEADER.stepSeconds] = fleet?.stepSeconds ?? 1;
    if (fleet) {
      for (const r of robots) {
        if (r.stage === 'defect') h[HEADER.robotsDefect]!++;
        else if (r.stage === 'charging' || r.stage === 'toCharger') h[HEADER.robotsCharging]!++;
        else if (r.stage === 'parked') h[HEADER.robotsIdle]!++;
        else h[HEADER.robotsWorking]!++;
      }
      h[HEADER.plans] = fleet.stats.plans;
      h[HEADER.failedPlans] = fleet.stats.failedPlans;
      h[HEADER.bumps] = fleet.stats.bumps;
      h[HEADER.jobsDone] = fleet.stats.jobsDone;
      h[HEADER.rackOrders] = fleet.orders.length;
    }

    // Packets on conveyors: previous and current pose, and how long they have been waiting.
    let i = 0;
    const dockIndex = new Map<number, number>();
    w.layout.dockNodes.forEach((n, d) => dockIndex.set(n, d));
    for (const c of w.conveyors) {
      if (c.packets.length === 0) continue;
      const edge = w.layout.graph.edge(c.edgeId);
      for (const p of c.packets) {
        pointOnEdge(edge, p.s, this.point);
        let t = this.packetTraces.get(p.id);
        if (!t) {
          t = {
            x: this.point.x,
            z: this.point.z,
            h: this.point.heading,
            blockedSince: -1,
            seen: 0,
          };
          this.packetTraces.set(p.id, t);
        }
        if (p.blocked) {
          if (t.blockedSince < 0) t.blockedSince = now;
        } else t.blockedSince = -1;
        const o = i * PACKET_STRIDE;
        const a = v.packets;
        a[o] = t.x;
        a[o + 1] = t.z;
        a[o + 2] = t.h;
        a[o + 3] = this.point.x;
        a[o + 4] = this.point.z;
        a[o + 5] = this.point.heading;
        a[o + 6] = t.blockedSince < 0 ? 0 : now - t.blockedSince;
        a[o + 7] = dockIndex.get(p.destination) ?? -1;
        v.packetIds[i] = p.id;
        t.x = this.point.x;
        t.z = this.point.z;
        t.h = this.point.heading;
        t.seen = this.generation;
        i++;
      }
    }
    // Forget packets that left the conveyors.
    if (this.generation % 30 === 0) {
      for (const [id, t] of this.packetTraces)
        if (t.seen !== this.generation) this.packetTraces.delete(id);
    }

    // Robots.
    let routeOffset = 0;
    robots.forEach((r, k) => {
      const mo = r.motion;
      let t = this.robotTraces[k];
      if (!t) {
        t = { x: mo.x, z: mo.z, h: mo.heading, blockedSince: -1, seen: 0 };
        this.robotTraces[k] = t;
      }
      const o = k * ROBOT_STRIDE;
      const a = v.robots;
      a[o + ROBOT.x0] = t.x;
      a[o + ROBOT.z0] = t.z;
      a[o + ROBOT.h0] = t.h;
      a[o + ROBOT.x1] = mo.x;
      a[o + ROBOT.z1] = mo.z;
      a[o + ROBOT.h1] = mo.heading;
      a[o + ROBOT.stage] = STAGES.indexOf(r.stage);
      a[o + ROBOT.battery] = r.battery;
      a[o + ROBOT.load] = r.load.length;
      a[o + ROBOT.speed] = mo.v;
      a[o + ROBOT.job] = r.job ? JOBS.indexOf(r.job.kind) : 0;
      a[o + ROBOT.station] = (r.waitingFor ?? r.station)?.id ?? -1;
      const route = routes[k] as number[];
      a[o + ROBOT.routeOffset] = routeOffset;
      a[o + ROBOT.routeLength] = route.length;
      a[o + ROBOT.planEnd] = r.planStart + r.cells.length - 1;
      a[o + ROBOT.waiting] = r.waitingFor ? 1 : r.failures > 0 ? 2 : 0;
      for (const cell of route) {
        v.routes[routeOffset * 2] = fleet!.grid.x(cell);
        v.routes[routeOffset * 2 + 1] = fleet!.grid.z(cell);
        routeOffset++;
      }
      t.x = mo.x;
      t.z = mo.z;
      t.h = mo.heading;
    });

    w.docks.forEach((d, k) => {
      const o = k * DOCK_STRIDE;
      v.docks[o] = d.staged.length;
      v.docks[o + 1] = TRUCK_STATES.indexOf(d.truck.state);
      v.docks[o + 2] = d.truck.awayLeft;
      v.docks[o + 3] = d.truck.load;
      v.docks[o + 4] = d.blockedUntil > now ? 1 : 0;
      v.docks[o + 5] = Math.max(0, d.blockedUntil - now);
    });
    w.inbounds.forEach((inb, k) => (v.inbounds[k] = inb.backlog.length));
    w.lanes.forEach((l, k) => {
      const o = k * LANE_STRIDE;
      v.lanes[o] = l.active ? 1 : 0;
      v.lanes[o + 1] = l.pickup.length;
      v.lanes[o + 2] = l.drop.length;
      v.lanes[o + 3] = l.carried;
    });
    w.failures.active.forEach((f, k) => {
      const o = k * FAILURE_STRIDE;
      v.failures[o] = FAILURE_KINDS.indexOf(f.kind);
      v.failures[o + 1] = f.target;
      v.failures[o + 2] = f.startedAt;
      v.failures[o + 3] = f.endsAt;
      v.failures[o + 4] = f.id;
    });
    w.conveyors.forEach((c, k) => {
      v.conveyors[k * CONVEYOR_STRIDE] = c.status === 'ok' ? 0 : 1;
      let blocked = 0;
      for (const p of c.packets) if (p.blocked) blocked++;
      v.conveyors[k * CONVEYOR_STRIDE + 1] = blocked;
    });

    this.prevTime = now;
    return buffer;
  }
}
