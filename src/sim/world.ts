import {
  advanceConveyor,
  canAccept,
  createConveyor,
  popHead,
  pushPacket,
  readyHead,
  type Conveyor,
  type ConveyorStatus,
} from './conveyor';
import { DEFAULT_FLEET, Fleet, type BypassLane, type FleetConfig, type FleetHost } from './fleet';
import type { Station } from './floor';
import { createDefaultLayout, type WarehouseLayout } from './layout';
import { Metrics } from './metrics';
import { createPacket, type Packet } from './packet';
import { deriveSeed, Rng } from './rng';
import { ShortestPathRouter, type Router } from './router';

export interface SimConfig {
  readonly seed: number;
  /** Fixed time step, in seconds. */
  readonly dt: number;
  /** Packets created per second, summed over all inbounds. */
  readonly arrivalRate: number;
  /** Relative share of packets per dock (same order as layout.dockNodes); uniform when omitted. */
  readonly destinationWeights?: readonly number[];
  readonly conveyorSpeed: number;
  /** Minimum center-to-center distance between packets on a belt, in meters. */
  readonly packetSpacing: number;
  /** Packets per second each dock can sort onto its staging area. */
  readonly dockServiceRate: number;
  readonly stagingCapacity: number;
  readonly truckCapacity: number;
  /** Packets per second moved from staging into a docked truck. */
  readonly truckLoadRate: number;
  /** Seconds a full truck is away before an empty one docks. */
  readonly truckAwayTime: number;
  /** Window of the "recent" metrics, in simulation seconds. */
  readonly metricsWindow: number;
  /** Robots (AGVs) on the floor; 0 turns the fleet off. */
  readonly robots: number;
  /** Stock orders per second picked from the racks by robots. */
  readonly rackOrderRate: number;
  /** Fleet tuning (motion, battery, capacity); defaults in fleet.ts. */
  readonly fleet?: Partial<FleetConfig>;
}

export const DEFAULT_CONFIG: SimConfig = {
  seed: 20261002,
  dt: 1 / 60,
  arrivalRate: 3.6,
  conveyorSpeed: 2.0,
  packetSpacing: 0.6,
  dockServiceRate: 1.0,
  stagingCapacity: 160,
  truckCapacity: 96,
  truckLoadRate: 4,
  truckAwayTime: 25,
  metricsWindow: 120,
  robots: 40,
  rackOrderRate: 0.25,
};

/** Conveyors without a conveyor alternative, bridged by robots when broken. */
const BYPASSES: readonly [string, string][] = [
  ['A4', 'S1'],
  ['B3', 'B4'],
  ['B4', 'S2'],
];

export interface Inbound {
  readonly nodeId: number;
  /** Packets waiting to enter the inbound conveyor, oldest first. */
  readonly backlog: Packet[];
  nextArrivalAt: number;
}

export type TruckState = 'docked' | 'loading' | 'away';

export interface Truck {
  state: TruckState;
  load: number;
  /** Seconds left while away. */
  awayLeft: number;
  loadProgress: number;
}

export interface Dock {
  readonly index: number;
  readonly nodeId: number;
  /** Sorted packets waiting for a truck, oldest first. */
  readonly staged: Packet[];
  serviceProgress: number;
  readonly truck: Truck;
  /** Dock out of service until this time (failure), seconds. */
  blockedUntil: number;
}

/** Aggregates recomputed at the end of every step (the HUD and tests read these). */
export interface WorldStats {
  backlog: number;
  onConveyors: number;
  staged: number;
  /** Packets queuing: backlog, packets blocked on a belt and packets waiting for a bypass robot. */
  waiting: number;
  /** Packets in bypass buffers (both ends). */
  inBypass: number;
  /** Packets carried by robots. */
  onRobots: number;
  /** Stock-order packets still on their rack shelf. */
  rackPending: number;
}

/**
 * Deterministic discrete-time simulation of the distribution center.
 * No rendering, no wall clock, no Math.random: `step()` advances exactly `dt`
 * seconds and the same config always produces the same sequence of states.
 */
export class World implements FleetHost {
  readonly config: SimConfig;
  readonly layout: WarehouseLayout;
  /** One conveyor per graph edge, indexed by edge id. */
  readonly conveyors: Conveyor[];
  readonly inbounds: Inbound[];
  readonly docks: Dock[];
  readonly metrics: Metrics;
  readonly stats: WorldStats = {
    backlog: 0,
    onConveyors: 0,
    staged: 0,
    waiting: 0,
    inBypass: 0,
    onRobots: 0,
    rackPending: 0,
  };
  readonly lanes: BypassLane[] = [];
  /** null when the world runs without robots. */
  readonly fleet: Fleet | null;
  /** Lane by conveyor edge id. */
  private readonly laneByEdge = new Map<number, BypassLane>();
  tick = 0;

  private router: Router;
  private readonly orderRng: Rng;
  private readonly destinationWeights: readonly number[];
  /** Round-robin pointer over incoming edges, per node, so merges are fair. */
  private readonly roundRobin: Int32Array;
  private nextPacketId = 1;
  private arrivalRate: number;

  constructor(config: Partial<SimConfig> = {}, layout: WarehouseLayout = createDefaultLayout()) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    validateConfig(this.config);
    this.layout = layout;
    const { graph } = layout;
    this.conveyors = graph.edges.map((e) =>
      createConveyor(e.id, e.length, this.config.conveyorSpeed, this.config.packetSpacing),
    );
    this.orderRng = new Rng(deriveSeed(this.config.seed, 'orders'));
    this.arrivalRate = this.config.arrivalRate;
    this.destinationWeights = this.config.destinationWeights ?? layout.dockNodes.map(() => 1);
    if (this.destinationWeights.length !== layout.dockNodes.length) {
      throw new Error('destinationWeights must have one entry per dock');
    }
    this.inbounds = layout.inboundNodes.map((nodeId) => ({
      nodeId,
      backlog: [],
      nextArrivalAt: this.nextInterval(),
    }));
    this.docks = layout.dockNodes.map((nodeId, index) => ({
      index,
      nodeId,
      staged: [],
      serviceProgress: 0,
      truck: { state: 'docked', load: 0, awayLeft: 0, loadProgress: 0 },
      blockedUntil: 0,
    }));
    this.roundRobin = new Int32Array(graph.nodes.length);
    this.metrics = new Metrics(this.config.metricsWindow);
    this.router = new ShortestPathRouter(graph, layout.dockNodes);
    if (this.config.robots > 0) {
      const fleetConfig: FleetConfig = {
        ...DEFAULT_FLEET,
        ...this.config.fleet,
        robots: this.config.robots,
        rackOrderRate: this.config.rackOrderRate,
      };
      this.fleet = new Fleet(layout, this, fleetConfig, this.config.seed, this.config.dt);
      this.createLanes(this.fleet);
    } else {
      this.fleet = null;
    }
  }

  private createLanes(fleet: Fleet): void {
    const { graph } = this.layout;
    const byName = (name: string) => {
      const n = graph.nodes.find((x) => x.name === name);
      if (!n) throw new Error(`Node ${name} missing`);
      return n;
    };
    const station = (nodeId: number): Station => {
      const st = fleet.grid.stations.find((x) => x.kind === 'bypass' && x.ref === nodeId);
      if (!st) throw new Error(`No bypass station at node ${nodeId}`);
      return st;
    };
    BYPASSES.forEach(([from, to], id) => {
      const a = byName(from);
      const b = byName(to);
      const edge = graph.edges.find((e) => e.from === a.id && e.to === b.id);
      if (!edge) throw new Error(`No conveyor ${from} to ${to}`);
      const lane: BypassLane = {
        id,
        edgeId: edge.id,
        label: `${from}→${to}`,
        pickupNode: a.id,
        dropNode: b.id,
        pickupStation: station(a.id),
        dropStation: station(b.id),
        pickup: [],
        drop: [],
        capacity: 18,
        active: false,
        carried: 0,
      };
      this.lanes.push(lane);
      this.laneByEdge.set(edge.id, lane);
    });
  }

  // ---------------------------------------------------------------- FleetHost

  createRackPacket(dockIndex: number, createdAt: number): Packet {
    const p = createPacket(
      this.nextPacketId++,
      -1,
      this.layout.dockNodes[dockIndex] as number,
      createdAt,
    );
    p.state = 'rack';
    this.metrics.created++;
    return p;
  }

  deliverToDock(dockIndex: number, packets: Packet[], now: number): boolean {
    const dock = this.docks[dockIndex] as Dock;
    if (dock.blockedUntil > now) return false;
    if (dock.staged.length + packets.length > this.config.stagingCapacity) return false;
    for (const p of packets) {
      if (p.destination !== dock.nodeId) this.metrics.misrouted++;
      p.state = 'staged';
      p.blocked = false;
      p.deliveredAt = now;
      dock.staged.push(p);
      this.metrics.recordDelivery(now, now - p.createdAt);
      this.metrics.deliveredByRobots++;
    }
    return true;
  }

  takeFromLane(lane: BypassLane, max: number): Packet[] {
    return lane.pickup.splice(0, Math.min(max, lane.pickup.length));
  }

  dropIntoLane(lane: BypassLane, packets: Packet[]): boolean {
    if (lane.drop.length + packets.length > lane.capacity) return false;
    for (const p of packets) {
      p.state = 'bypass';
      lane.drop.push(p);
    }
    return true;
  }

  /** Blocks a dock (no sorting, no robot drops) until `until` seconds. */
  setDockBlocked(dockIndex: number, until: number): void {
    const dock = this.docks[dockIndex];
    if (!dock) throw new Error(`Unknown dock ${dockIndex}`);
    dock.blockedUntil = until;
  }

  /** Simulation time in seconds (derived from the integer tick, so it never drifts). */
  get time(): number {
    return this.tick * this.config.dt;
  }

  get currentArrivalRate(): number {
    return this.arrivalRate;
  }

  setRouter(router: Router): void {
    this.router = router;
  }

  setConveyorStatus(edgeId: number, status: ConveyorStatus): void {
    const c = this.conveyors[edgeId];
    if (!c) throw new Error(`Unknown conveyor ${edgeId}`);
    c.status = status;
  }

  /** Changes the order rate from now on; already scheduled arrivals are kept. */
  setArrivalRate(rate: number): void {
    if (!(rate > 0)) throw new Error('arrival rate must be positive');
    this.arrivalRate = rate;
  }

  step(): void {
    this.tick++;
    const now = this.time;
    const dt = this.config.dt;
    this.generateOrders(now);
    for (const lane of this.lanes) lane.active = this.conveyors[lane.edgeId]?.status !== 'ok';
    for (const c of this.conveyors) advanceConveyor(c, dt);
    this.serveDocks(now, dt);
    this.transferAtJunctions();
    this.induct();
    this.fleet?.update(this.tick, now, dt);
    this.updateTrucks(dt);
    this.metrics.evict(now);
    this.updateStats();
  }

  stepMany(steps: number): void {
    for (let i = 0; i < steps; i++) this.step();
  }

  private nextInterval(): number {
    const perInbound = this.arrivalRate / this.layout.inboundNodes.length;
    return this.orderRng.exponential(perInbound);
  }

  private generateOrders(now: number): void {
    for (const inbound of this.inbounds) {
      while (inbound.nextArrivalAt <= now) {
        const dock = this.layout.dockNodes[
          this.orderRng.weightedIndex(this.destinationWeights)
        ] as number;
        inbound.backlog.push(
          createPacket(this.nextPacketId++, inbound.nodeId, dock, inbound.nextArrivalAt),
        );
        this.metrics.created++;
        inbound.nextArrivalAt += this.nextInterval();
      }
    }
  }

  /** Each dock takes one packet from the end of an incoming belt per service interval. */
  private serveDocks(now: number, dt: number): void {
    const { graph } = this.layout;
    for (const dock of this.docks) {
      if (dock.blockedUntil > now) continue;
      dock.serviceProgress = Math.min(1, dock.serviceProgress + dt * this.config.dockServiceRate);
      if (dock.serviceProgress < 1 || dock.staged.length >= this.config.stagingCapacity) continue;
      const inEdges = graph.node(dock.nodeId).inEdges;
      const start = this.roundRobin[dock.nodeId] as number;
      for (let k = 0; k < inEdges.length; k++) {
        const idx = (start + k) % inEdges.length;
        const conveyor = this.conveyors[inEdges[idx] as number] as Conveyor;
        if (!readyHead(conveyor)) continue;
        const p = popHead(conveyor);
        if (p.destination !== dock.nodeId) this.metrics.misrouted++;
        p.state = 'staged';
        p.blocked = false;
        p.deliveredAt = now;
        dock.staged.push(p);
        dock.serviceProgress -= 1;
        this.metrics.recordDelivery(now, now - p.createdAt);
        this.roundRobin[dock.nodeId] = (idx + 1) % inEdges.length;
        break;
      }
    }
  }

  /**
   * Moves packets waiting at the end of a belt onto the next belt chosen by
   * the router. A packet whose next belt is a broken single point of failure
   * goes into that conveyor's robot bypass instead; packets that robots
   * dropped at a node join it like one more input.
   */
  private transferAtJunctions(): void {
    const { graph } = this.layout;
    for (const node of graph.nodes) {
      if (node.kind !== 'junction') continue;
      const inEdges = node.inEdges;
      const start = this.roundRobin[node.id] as number;
      let nextStart = start;
      for (let k = 0; k < inEdges.length; k++) {
        const idx = (start + k) % inEdges.length;
        const from = this.conveyors[inEdges[idx] as number] as Conveyor;
        const head = readyHead(from);
        if (!head) continue;
        if (!this.forward(node.id, head, from)) continue;
        // The next round starts after the last edge served, so no input starves.
        nextStart = (idx + 1) % inEdges.length;
      }
      this.roundRobin[node.id] = nextStart;
      for (const lane of this.lanes) {
        if (lane.dropNode !== node.id) continue;
        const head = lane.drop[0];
        if (head && this.forward(node.id, head, null)) lane.drop.shift();
      }
    }
  }

  /**
   * Sends `p` (head of belt `from`, or of a bypass drop buffer when `from` is
   * null) from `nodeId` onto its next belt or into a bypass. False: it waits.
   */
  private forward(nodeId: number, p: Packet, from: Conveyor | null): boolean {
    const outEdge = this.router.nextEdge(nodeId, p);
    const to = outEdge >= 0 ? this.conveyors[outEdge] : undefined;
    if (!to) return false;
    if (canAccept(to)) {
      if (from) popHead(from);
      pushPacket(to, p);
      return true;
    }
    const lane = this.laneByEdge.get(outEdge);
    if (this.fleet && lane?.active && lane.pickup.length < lane.capacity) {
      if (from) popHead(from);
      p.edge = -1;
      p.state = 'bypass';
      p.blocked = true;
      lane.pickup.push(p);
      return true;
    }
    return false;
  }

  /** Moves the oldest backlog packet of each inbound onto its first conveyor. */
  private induct(): void {
    for (const inbound of this.inbounds) {
      const head = inbound.backlog[0];
      if (!head) continue;
      const outEdge = this.router.nextEdge(inbound.nodeId, head);
      const to = outEdge >= 0 ? this.conveyors[outEdge] : undefined;
      if (!to || !canAccept(to)) continue;
      inbound.backlog.shift();
      pushPacket(to, head);
    }
  }

  private updateTrucks(dt: number): void {
    const { truckCapacity, truckLoadRate, truckAwayTime } = this.config;
    for (const dock of this.docks) {
      const truck = dock.truck;
      if (truck.state === 'away') {
        truck.awayLeft -= dt;
        if (truck.awayLeft <= 0) {
          truck.state = 'docked';
          truck.load = 0;
          truck.awayLeft = 0;
        }
        continue;
      }
      // Loading starts once a full truckload is waiting on the staging area.
      if (truck.state === 'docked' && dock.staged.length >= truckCapacity) {
        truck.state = 'loading';
        truck.loadProgress = 0;
      }
      if (truck.state !== 'loading') continue;
      truck.loadProgress += dt * truckLoadRate;
      while (truck.loadProgress >= 1 && truck.load < truckCapacity && dock.staged.length > 0) {
        dock.staged.shift();
        truck.load++;
        truck.loadProgress -= 1;
        this.metrics.shipped++;
      }
      if (truck.load >= truckCapacity) {
        truck.state = 'away';
        truck.awayLeft = truckAwayTime;
      }
    }
  }

  private updateStats(): void {
    let backlog = 0;
    let onConveyors = 0;
    let blocked = 0;
    let staged = 0;
    let inBypass = 0;
    let waitingBypass = 0;
    for (const inbound of this.inbounds) backlog += inbound.backlog.length;
    for (const c of this.conveyors) {
      onConveyors += c.packets.length;
      for (const p of c.packets) if (p.blocked) blocked++;
    }
    for (const dock of this.docks) staged += dock.staged.length;
    for (const lane of this.lanes) {
      inBypass += lane.pickup.length + lane.drop.length;
      waitingBypass += lane.pickup.length;
    }
    let onRobots = 0;
    let rackPending = 0;
    if (this.fleet) {
      for (const r of this.fleet.robots) {
        onRobots += r.load.length;
        if (r.job?.kind === 'rack' && r.load.length === 0)
          rackPending += r.job.order.packets.length;
      }
      for (const o of this.fleet.orders) rackPending += o.packets.length;
    }
    this.stats.backlog = backlog;
    this.stats.onConveyors = onConveyors;
    this.stats.staged = staged;
    this.stats.inBypass = inBypass;
    this.stats.onRobots = onRobots;
    this.stats.rackPending = rackPending;
    this.stats.waiting = backlog + blocked + waitingBypass;
  }
}

function validateConfig(c: SimConfig): void {
  const positive: (keyof SimConfig)[] = [
    'dt',
    'arrivalRate',
    'conveyorSpeed',
    'packetSpacing',
    'dockServiceRate',
    'stagingCapacity',
    'truckCapacity',
    'truckLoadRate',
    'truckAwayTime',
    'metricsWindow',
  ];
  if (!(c.robots >= 0) || !Number.isInteger(c.robots))
    throw new Error('robots must be a whole number');
  if (!(c.rackOrderRate >= 0)) throw new Error('rackOrderRate cannot be negative');
  for (const key of positive) {
    const v = c[key];
    if (typeof v !== 'number' || !(v > 0)) throw new Error(`${key} must be positive`);
  }
  // A truck that needs more than the staging area can hold would never load.
  if (c.truckCapacity > c.stagingCapacity) {
    throw new Error('truckCapacity cannot exceed stagingCapacity');
  }
}
