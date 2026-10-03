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
import {
  FailureInjector,
  type FailureHost,
  type FailureKind,
  type SimEvent,
  type SimEventKind,
} from './failures';
import { DEFAULT_FLEET, Fleet, type BypassLane, type FleetConfig, type FleetHost } from './fleet';
import type { Station } from './floor';
import { createDefaultLayout, type WarehouseLayout } from './layout';
import { Metrics } from './metrics';
import { createPacket, type Packet, type PacketState } from './packet';
import { deriveSeed, Rng } from './rng';
import type { Router } from './router';
import { SplitRouter } from './routing';
import { StateReader, StateWriter, type EncodedState } from './state';

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
  /** Robots bridge broken conveyors without alternative (off = packets just wait). */
  readonly robotBypass: boolean;
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
  robotBypass: true,
};

/** Events kept for the UI (captions, history). */
const MAX_EVENTS = 300;

/** Bumped whenever the checkpoint layout changes. */
const CHECKPOINT_VERSION = 5;
const PACKET_STATES: readonly PacketState[] = [
  'backlog',
  'rack',
  'conveyor',
  'bypass',
  'robot',
  'staged',
];
const CONVEYOR_STATUSES: readonly ConveyorStatus[] = ['ok', 'broken'];
const TRUCK_STATES: readonly TruckState[] = ['docked', 'loading', 'away'];

/** The complete changing state of a world at one tick. */
export interface Checkpoint {
  readonly tick: number;
  readonly state: EncodedState;
}

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
export class World implements FleetHost, FailureHost {
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
  /** Packets that left each conveyor, and packets delivered to each dock, since the start. */
  readonly conveyorExits: Int32Array;
  readonly dockDeliveries: Int32Array;
  /** null when the world runs without robots. */
  readonly fleet: Fleet | null;
  /** Lane by conveyor edge id. */
  private readonly laneByEdge = new Map<number, BypassLane>();
  readonly failures: FailureInjector;
  /** Latest events, oldest first (bounded). */
  readonly events: SimEvent[] = [];
  private nextEventId = 1;
  private baseArrivalRate: number;
  private surgeFactor = 1;
  tick = 0;

  private router: Router;
  /** The routing the operations layer adjusts (the default router). */
  readonly routing: SplitRouter;
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
    this.baseArrivalRate = this.config.arrivalRate;
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
    this.conveyorExits = new Int32Array(this.conveyors.length);
    this.dockDeliveries = new Int32Array(this.docks.length);
    this.metrics = new Metrics(this.config.metricsWindow);
    this.routing = new SplitRouter(graph, layout.dockNodes);
    this.router = this.routing;
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
    this.failures = new FailureInjector(this, this.config.seed);
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

  // ---------------------------------------------------------------- checkpoints

  /**
   * Everything that changes while the world runs, in a compact binary form.
   * The layout, the floor, the stations and the routing tables come from the
   * configuration and are rebuilt by the constructor, so a checkpoint only
   * loads into a world built with the same configuration. The event feed is
   * not part of it (the recorder keeps the full log); event ids continue.
   */
  saveState(): Checkpoint {
    const w = new StateWriter();
    w.int(CHECKPOINT_VERSION);
    w.int(this.fleet?.robots.length ?? 0);
    w.int(this.tick);
    w.int(this.nextPacketId);
    w.int(this.nextEventId);
    w.float(this.baseArrivalRate);
    w.float(this.surgeFactor);
    w.float(this.arrivalRate);
    w.int(this.orderRng.getState());
    w.ints32(this.roundRobin);
    w.ints32(this.conveyorExits);
    w.ints32(this.dockDeliveries);

    // Packets waiting at an inbound are still as created: id, destination and
    // creation time say everything (16 bytes instead of 60). They are most of
    // the packets when the piles grow.
    const compact = this.inbounds.map((inbound) =>
      inbound.backlog.every((p) => isAsCreated(p, inbound.nodeId)),
    );
    const packets = this.livePackets(compact);
    w.int(packets.size);
    for (const p of packets.values()) {
      w.int(p.id);
      w.int(p.origin);
      w.int(p.destination);
      w.float(p.createdAt);
      w.pick(p.state, PACKET_STATES);
      w.int(p.edge);
      w.float(p.s);
      w.float(p.prevS);
      w.bool(p.blocked);
      w.float(p.deliveredAt);
      w.int(p.next);
    }
    const ids = (list: readonly Packet[]) => w.ints32(list.map((p) => p.id));

    this.inbounds.forEach((inbound, i) => {
      w.float(inbound.nextArrivalAt);
      w.bool(compact[i] as boolean);
      if (!compact[i]) {
        ids(inbound.backlog);
        return;
      }
      w.int(inbound.backlog.length);
      for (const p of inbound.backlog) {
        w.int(p.id);
        w.int(p.destination);
        w.float(p.createdAt);
      }
    });
    for (const c of this.conveyors) {
      w.pick(c.status, CONVEYOR_STATUSES);
      w.float(c.speed);
      ids(c.packets);
    }
    for (const d of this.docks) {
      w.float(d.serviceProgress);
      w.pick(d.truck.state, TRUCK_STATES);
      w.int(d.truck.load);
      w.float(d.truck.awayLeft);
      w.float(d.truck.loadProgress);
      w.float(d.blockedUntil);
      ids(d.staged);
    }
    for (const lane of this.lanes) {
      w.bool(lane.active);
      w.int(lane.carried);
      ids(lane.pickup);
      ids(lane.drop);
    }
    this.metrics.save(w);
    this.routing.save(w);
    this.failures.save(w);
    this.fleet?.save(w);
    return { tick: this.tick, state: w.finish() };
  }

  /** Puts this world exactly in the state of `checkpoint` (taken from a world with the same configuration). */
  loadState(checkpoint: Checkpoint): void {
    const r = new StateReader(checkpoint.state);
    if (r.int() !== CHECKPOINT_VERSION) throw new Error('checkpoint from another version');
    if (r.int() !== (this.fleet?.robots.length ?? 0))
      throw new Error('checkpoint from another fleet');
    this.tick = r.int();
    this.nextPacketId = r.int();
    this.nextEventId = r.int();
    this.baseArrivalRate = r.float();
    this.surgeFactor = r.float();
    this.arrivalRate = r.float();
    this.orderRng.setState(r.int());
    this.roundRobin.set(r.ints32());
    this.conveyorExits.set(r.ints32());
    this.dockDeliveries.set(r.ints32());

    const byId = new Map<number, Packet>();
    for (let n = r.int(); n > 0; n--) {
      const p: Packet = {
        id: r.int(),
        origin: r.int(),
        destination: r.int(),
        createdAt: r.float(),
        state: r.pick(PACKET_STATES),
        edge: r.int(),
        s: r.float(),
        prevS: r.float(),
        blocked: r.bool(),
        deliveredAt: r.float(),
        next: r.int(),
      };
      byId.set(p.id, p);
    }
    const packet = (id: number) => {
      const p = byId.get(id);
      if (!p) throw new Error(`checkpoint refers to unknown packet ${id}`);
      return p;
    };
    const fill = (list: Packet[]) => {
      list.length = 0;
      for (const id of r.ints32()) list.push(packet(id));
    };

    for (const inbound of this.inbounds) {
      inbound.nextArrivalAt = r.float();
      if (!r.bool()) {
        fill(inbound.backlog);
        continue;
      }
      inbound.backlog.length = 0;
      for (let n = r.int(); n > 0; n--) {
        inbound.backlog.push(createPacket(r.int(), inbound.nodeId, r.int(), r.float()));
      }
    }
    for (const c of this.conveyors) {
      c.status = r.pick(CONVEYOR_STATUSES);
      c.speed = r.float();
      fill(c.packets);
    }
    for (const d of this.docks) {
      d.serviceProgress = r.float();
      d.truck.state = r.pick(TRUCK_STATES);
      d.truck.load = r.int();
      d.truck.awayLeft = r.float();
      d.truck.loadProgress = r.float();
      d.blockedUntil = r.float();
      fill(d.staged);
    }
    for (const lane of this.lanes) {
      lane.active = r.bool();
      lane.carried = r.int();
      fill(lane.pickup);
      fill(lane.drop);
    }
    this.metrics.load(r);
    this.routing.load(r);
    this.failures.load(r);
    this.fleet?.load(r, packet);
    r.end();
    this.events.length = 0;
    this.updateStats();
  }

  /**
   * Every packet still in the building, once each (some are in two lists, e.g.
   * an order and a robot's load), except the inbound piles written compactly.
   */
  private livePackets(compactInbound: readonly boolean[]): Map<number, Packet> {
    const out = new Map<number, Packet>();
    const add = (list: readonly Packet[]) => {
      for (const p of list) out.set(p.id, p);
    };
    this.inbounds.forEach((inbound, i) => {
      if (!compactInbound[i]) add(inbound.backlog);
    });
    for (const c of this.conveyors) add(c.packets);
    for (const d of this.docks) add(d.staged);
    for (const lane of this.lanes) {
      add(lane.pickup);
      add(lane.drop);
    }
    if (this.fleet) {
      for (const o of this.fleet.orders) add(o.packets);
      for (const robot of this.fleet.robots) {
        add(robot.load);
        if (robot.job?.kind === 'rack') add(robot.job.order.packets);
      }
    }
    return out;
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
      this.dockDeliveries[dockIndex]!++;
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

  /** Order rate before any surge (what the load test switches). */
  get baseRate(): number {
    return this.baseArrivalRate;
  }

  setRouter(router: Router): void {
    this.router = router;
  }

  setConveyorStatus(edgeId: number, status: ConveyorStatus): void {
    const c = this.conveyors[edgeId];
    if (!c) throw new Error(`Unknown conveyor ${edgeId}`);
    c.status = status;
  }

  /** Changes the base order rate from now on; already scheduled arrivals are kept. */
  setArrivalRate(rate: number): void {
    if (!(rate > 0)) throw new Error('arrival rate must be positive');
    this.baseArrivalRate = rate;
    this.arrivalRate = rate * this.surgeFactor;
  }

  // ---------------------------------------------------------------- FailureHost

  get conveyorCount(): number {
    return this.conveyors.length;
  }

  conveyorLabel(edgeId: number): string {
    const { graph } = this.layout;
    const e = graph.edge(edgeId);
    return `${e.name} (${graph.node(e.from).name}→${graph.node(e.to).name})`;
  }

  isConveyorBroken(edgeId: number): boolean {
    return this.conveyors[edgeId]?.status !== 'ok';
  }

  get bypassEdges(): number[] {
    return this.lanes.map((l) => l.edgeId);
  }

  setConveyorBroken(edgeId: number, broken: boolean): void {
    this.setConveyorStatus(edgeId, broken ? 'broken' : 'ok');
  }

  /** Multiplies the order rates (inbound and racks) while a surge lasts. */
  setSurge(factor: number): void {
    this.surgeFactor = factor;
    this.arrivalRate = this.baseArrivalRate * factor;
    this.fleet?.setRackOrderRate(this.config.rackOrderRate * (factor > 1 ? 2 : 1));
  }

  get robotCount(): number {
    return this.fleet?.robots.length ?? 0;
  }

  canBreakRobot(robotId: number): boolean {
    const r = this.fleet?.robots[robotId];
    return !!r && r.stage !== 'defect' && r.stage !== 'charging';
  }

  setRobotDefect(robotId: number, until: number): void {
    this.fleet?.setDefect(robotId, until);
  }

  get dockCount(): number {
    return this.docks.length;
  }

  emit(kind: SimEventKind, text: string, failure?: FailureKind, target?: number): void {
    const entity =
      failure === 'conveyor' || failure === 'robot' || failure === 'dock'
        ? [`${failure}:${target}`]
        : undefined;
    this.push(kind, text, { failure, target, about: entity });
  }

  notify(kind: SimEventKind, text: string, robots: readonly number[]): void {
    this.push(kind, text, { about: robots.map((r) => `robot:${r}`) });
  }

  private push(
    kind: SimEventKind,
    text: string,
    extra: {
      failure?: FailureKind | undefined;
      target?: number | undefined;
      about?: readonly string[] | undefined;
    },
  ): void {
    const e: SimEvent = {
      id: this.nextEventId++,
      time: this.time,
      kind,
      text,
      ...(extra.failure !== undefined ? { failure: extra.failure } : {}),
      ...(extra.target !== undefined ? { target: extra.target } : {}),
      ...(extra.about?.length ? { about: extra.about } : {}),
    };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  step(): void {
    this.tick++;
    const now = this.time;
    const dt = this.config.dt;
    this.failures.update(now);
    this.generateOrders(now);
    this.updateLanes();
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

  private updateLanes(): void {
    for (const lane of this.lanes) {
      const active = this.conveyors[lane.edgeId]?.status !== 'ok';
      if (active === lane.active) continue;
      lane.active = active;
      if (!this.fleet || !this.config.robotBypass) continue;
      if (active) {
        lane.carried = 0;
        this.push('bypass-start', `Robôs assumem o desvio ${lane.label}`, {
          about: [`conveyor:${lane.edgeId}`],
        });
      } else {
        this.push(
          'bypass-end',
          `Desvio ${lane.label} encerrado: ${lane.carried} pacotes levados por robôs`,
          { about: [`conveyor:${lane.edgeId}`] },
        );
      }
    }
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
        this.conveyorExits[conveyor.edgeId]!++;
        this.dockDeliveries[dock.index]!++;
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
    // The choice is made once per packet (at a decision junction it advances
    // the split) and kept while the packet waits; if the chosen belt breaks
    // in the meantime and robots are not bridging it, it chooses again.
    if (
      p.next >= 0 &&
      this.conveyors[p.next]?.status !== 'ok' &&
      !this.laneByEdge.get(p.next)?.active
    ) {
      p.next = -1;
    }
    if (p.next < 0) p.next = this.router.nextEdge(nodeId, p);
    const outEdge = p.next;
    const to = outEdge >= 0 ? this.conveyors[outEdge] : undefined;
    if (!to) return false;
    if (canAccept(to)) {
      if (from) this.leave(from);
      pushPacket(to, p);
      return true;
    }
    const lane = this.laneByEdge.get(outEdge);
    if (
      this.fleet &&
      this.config.robotBypass &&
      lane?.active &&
      lane.pickup.length < lane.capacity
    ) {
      if (from) this.leave(from);
      p.edge = -1;
      p.state = 'bypass';
      p.blocked = true;
      p.next = -1;
      lane.pickup.push(p);
      return true;
    }
    return false;
  }

  private leave(c: Conveyor): void {
    popHead(c);
    this.conveyorExits[c.edgeId]!++;
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

/** True while a packet still has every field `createPacket` gave it at `origin`. */
function isAsCreated(p: Packet, origin: number): boolean {
  return (
    p.origin === origin &&
    p.state === 'backlog' &&
    p.edge === -1 &&
    Object.is(p.s, 0) &&
    Object.is(p.prevS, 0) &&
    p.blocked &&
    p.deliveredAt === -1 &&
    p.next === -1
  );
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
