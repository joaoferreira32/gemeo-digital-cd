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
};

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
}

/** Aggregates recomputed at the end of every step (the HUD and tests read these). */
export interface WorldStats {
  backlog: number;
  onConveyors: number;
  staged: number;
  /** Packets queuing: everything in the backlog plus packets blocked on a belt. */
  waiting: number;
}

/**
 * Deterministic discrete-time simulation of the distribution center.
 * No rendering, no wall clock, no Math.random: `step()` advances exactly `dt`
 * seconds and the same config always produces the same sequence of states.
 */
export class World {
  readonly config: SimConfig;
  readonly layout: WarehouseLayout;
  /** One conveyor per graph edge, indexed by edge id. */
  readonly conveyors: Conveyor[];
  readonly inbounds: Inbound[];
  readonly docks: Dock[];
  readonly metrics: Metrics;
  readonly stats: WorldStats = { backlog: 0, onConveyors: 0, staged: 0, waiting: 0 };
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
    }));
    this.roundRobin = new Int32Array(graph.nodes.length);
    this.metrics = new Metrics(this.config.metricsWindow);
    this.router = new ShortestPathRouter(graph, layout.dockNodes);
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
    for (const c of this.conveyors) advanceConveyor(c, dt);
    this.serveDocks(now, dt);
    this.transferAtJunctions();
    this.induct();
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

  /** Moves packets waiting at the end of a belt onto the next belt chosen by the router. */
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
        const outEdge = this.router.nextEdge(node.id, head);
        const to = outEdge >= 0 ? this.conveyors[outEdge] : undefined;
        if (!to || !canAccept(to)) continue;
        pushPacket(to, popHead(from));
        // The next round starts after the last edge served, so no input starves.
        nextStart = (idx + 1) % inEdges.length;
      }
      this.roundRobin[node.id] = nextStart;
    }
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
    for (const inbound of this.inbounds) backlog += inbound.backlog.length;
    for (const c of this.conveyors) {
      onConveyors += c.packets.length;
      for (const p of c.packets) if (p.blocked) blocked++;
    }
    for (const dock of this.docks) staged += dock.staged.length;
    this.stats.backlog = backlog;
    this.stats.onConveyors = onConveyors;
    this.stats.staged = staged;
    this.stats.waiting = backlog + blocked;
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
  for (const key of positive) {
    const v = c[key];
    if (typeof v !== 'number' || !(v > 0)) throw new Error(`${key} must be positive`);
  }
  // A truck that needs more than the staging area can hold would never load.
  if (c.truckCapacity > c.stagingCapacity) {
    throw new Error('truckCapacity cannot exceed stagingCapacity');
  }
}
