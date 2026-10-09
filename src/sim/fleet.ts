import { UNREACHABLE, createFloorGrid, type FloorGrid, type Station } from './floor';
import type { WarehouseLayout } from './layout';
import { DEFAULT_MOTION, RobotMotion, type MotionParams } from './motion';
import type { Packet } from './packet';
import { CooperativePlanner, moveAllowed, startMode, waitMode, type PlanStart } from './planner';
import { ReservationTable } from './reservations';
import { deriveSeed, Rng } from './rng';
import type { SimEventKind } from './failures';
import type { StateReader, StateWriter } from './state';

/**
 * Fleet manager: hands out jobs, plans every robot with Cooperative A* over
 * the shared reservation table and drives their motion, batteries and
 * station queues.
 *
 * Invariants that keep the fleet collision- and deadlock-free:
 *  - every robot always owns its current cell in the table (a plan, or a hold
 *    on the last cell of its plan, with no end);
 *  - a robot replans only at step boundaries, from the cell it is committed
 *    to at the next boundary, so the part of its path already in use never
 *    changes;
 *  - a robot that cannot find a path stops on that committed cell and holds
 *    it; robots whose plans crossed that cell later replan ("bumping" — it
 *    always terminates, because each robot can only become a new holder once);
 *  - stations (rack faces, dock drops, bypass points, chargers, parking slots)
 *    are exclusive; a robot that finds one busy waits on a queue spot next to
 *    it instead of in the corridor;
 *  - a robot that keeps failing asks robots standing still on its route to
 *    step aside to the nearest free holdable cell;
 *  - a watchdog breaks the waits those requests do not solve (robots waiting
 *    for each other, robots stuck behind a broken one); see `watchdog`.
 */

export interface FleetConfig {
  readonly robots: number;
  readonly motion: MotionParams;
  /** Packets a robot carries per trip. */
  readonly capacity: number;
  readonly loadBaseSeconds: number;
  readonly loadPerPacketSeconds: number;
  /** Battery use in % per meter, plus extra while carrying something. */
  readonly batteryPerMeter: number;
  readonly batteryLoadedPerMeter: number;
  readonly batteryIdlePerSecond: number;
  readonly chargePerSecond: number;
  /** Below this a robot finishes its job and goes to charge. */
  readonly lowBattery: number;
  readonly fullBattery: number;
  /** Stock orders per second picked from the racks by robots. */
  readonly rackOrderRate: number;
  /** Robots working the same bypass at once. */
  readonly maxRobotsPerLane: number;
  /** Robots that keep failing ask the ones standing on their route to step aside. */
  readonly stepAside: boolean;
  /** Seconds without a path before the watchdog steps in (0 turns it off). */
  readonly watchdogSeconds: number;
}

export const DEFAULT_FLEET: FleetConfig = {
  robots: 40,
  motion: DEFAULT_MOTION,
  capacity: 6,
  loadBaseSeconds: 1.5,
  loadPerPacketSeconds: 0.35,
  batteryPerMeter: 0.08,
  batteryLoadedPerMeter: 0.03,
  batteryIdlePerSecond: 0.003,
  chargePerSecond: 1.6,
  lowBattery: 25,
  fullBattery: 95,
  rackOrderRate: 0.25,
  maxRobotsPerLane: 5,
  stepAside: true,
  watchdogSeconds: 6,
};

/** Robots carry packets around a conveyor without alternative while it is broken. */
export interface BypassLane {
  readonly id: number;
  readonly edgeId: number;
  readonly label: string;
  readonly pickupNode: number;
  readonly dropNode: number;
  readonly pickupStation: Station;
  readonly dropStation: Station;
  /** Packets waiting at the upstream node for a robot. */
  readonly pickup: Packet[];
  /** Packets dropped by robots, waiting to enter the downstream node. */
  readonly drop: Packet[];
  readonly capacity: number;
  active: boolean;
  carried: number;
}

export interface RackOrder {
  readonly id: number;
  readonly face: Station;
  readonly dock: number;
  readonly packets: Packet[];
}

/** What the fleet needs from the world it lives in. */
export interface FleetHost {
  readonly lanes: readonly BypassLane[];
  createRackPacket(dockIndex: number, createdAt: number): Packet;
  /** Puts carried packets on a dock's staging area; false when it cannot take them now. */
  deliverToDock(dockIndex: number, packets: Packet[], now: number): boolean;
  takeFromLane(lane: BypassLane, max: number): Packet[];
  /** False when the lane's drop buffer has no room. */
  dropIntoLane(lane: BypassLane, packets: Packet[]): boolean;
  /** Tells the viewer something about these robots. */
  notify(kind: SimEventKind, text: string, robots: readonly number[]): void;
}

export type RobotStage =
  | 'parked'
  | 'toPark'
  | 'toPickup'
  | 'loading'
  | 'toDrop'
  | 'unloading'
  | 'toCharger'
  | 'charging'
  | 'defect'
  /** Scripted move to a cell (scenarios). */
  | 'toPoint';

/** Every stage, in the order checkpoints and snapshots encode them. */
export const ROBOT_STAGES: readonly RobotStage[] = [
  'parked',
  'toPark',
  'toPickup',
  'loading',
  'toDrop',
  'unloading',
  'toCharger',
  'charging',
  'defect',
  'toPoint',
];

export type Job =
  | { kind: 'rack'; order: RackOrder }
  | { kind: 'bypass'; lane: BypassLane }
  | { kind: 'charge' }
  | { kind: 'park' }
  | { kind: 'goto'; cell: number };

export interface Robot {
  readonly id: number;
  readonly home: Station;
  readonly motion: RobotMotion;
  battery: number;
  stage: RobotStage;
  job: Job | null;
  load: Packet[];
  /** Station owned for the current leg. */
  station: Station | null;
  /** Busy station this robot is queuing for, and the queue spot it owns (-1 none). */
  waitingFor: Station | null;
  spot: number;
  goalCell: number;
  needsPlan: boolean;
  /** Timed cells being followed: cells[i] at step planStart + i. */
  cells: number[];
  planStart: number;
  /** Planner mode after each step of the latest plan, from modeStart on. */
  modes: number[];
  modeStart: number;
  dwellUntil: number;
  /** Consecutive failed plans and since when. */
  failures: number;
  failingSince: number;
  /** Cells to keep clear while stepping aside for a blocked robot. */
  evadeFrom: ReadonlySet<number> | null;
  evading: boolean;
  /** Where the robot steps aside to (its job goal stays in goalCell). */
  evadeGoal: number;
  resumeAt: number;
  /** Last time the watchdog acted on this robot, and the failing episode it last reported. */
  watchedAt: number;
  reportedEpisode: number;
  /** Failing episode (its start) already reported as stuck, or -1. */
  stuckSince: number;
  defectUntil: number;
  stageBeforeDefect: RobotStage;
  dwellLeftAtDefect: number;
  lastStageChange: number;
  jobsDone: number;
  delivered: number;
}

export interface FleetStats {
  plans: number;
  failedPlans: number;
  expansions: number;
  bumps: number;
  evades: number;
  jobsDone: number;
  rackOrdersCreated: number;
  rackOrdersDone: number;
  /** Longest time any robot spent unable to plan (seconds). */
  maxFailingSeconds: number;
  batteryDepleted: number;
  /** Watchdog: waiting cycles broken, cycles it could not break yet, robots sent to another station. */
  cyclesBroken: number;
  cyclesStalled: number;
  reroutes: number;
}

const QUEUE_SPOTS = 3;
/** Seconds without a path before a robot is reported stuck. */
export const STUCK_SECONDS = 20;

export class Fleet {
  readonly grid: FloorGrid;
  readonly table: ReservationTable;
  readonly planner: CooperativePlanner;
  readonly robots: Robot[] = [];
  readonly orders: RackOrder[] = [];
  readonly stats: FleetStats = {
    plans: 0,
    failedPlans: 0,
    expansions: 0,
    bumps: 0,
    evades: 0,
    jobsDone: 0,
    rackOrdersCreated: 0,
    rackOrdersDone: 0,
    maxFailingSeconds: 0,
    batteryDepleted: 0,
    cyclesBroken: 0,
    cyclesStalled: 0,
    reroutes: 0,
  };
  readonly ticksPerStep: number;
  /** Called on every stage change (the recorder keeps them for the history panels). */
  onStage: ((robot: number, stage: RobotStage, time: number) => void) | null = null;
  private readonly stationOwner: Int32Array;
  private readonly spotOwner = new Map<number, number>();
  private readonly queueSpots: number[][];
  private readonly rackRng: Rng;
  private nextOrderAt: number;
  private nextOrderId = 1;
  /** Current planner step (updated every planning round). */
  private k = 0;
  private orderRate: number;
  private readonly racks: Station[];
  private readonly chargers: Station[];
  private readonly dockStations: Station[][];

  constructor(
    readonly layout: WarehouseLayout,
    private readonly host: FleetHost,
    readonly config: FleetConfig,
    seed: number,
    dt: number,
  ) {
    this.grid = createFloorGrid(layout);
    const parking = this.grid.stations.filter((s) => s.kind === 'parking');
    if (config.robots > parking.length) throw new Error('more robots than parking slots');
    this.table = new ReservationTable(this.grid.cellCount, Math.max(1, config.robots), 512);
    this.planner = new CooperativePlanner(this.grid, this.table);
    this.ticksPerStep = Math.round(config.motion.stepSeconds / dt);
    if (Math.abs(this.ticksPerStep * dt - config.motion.stepSeconds) > 1e-9) {
      throw new Error('the planner step must be a whole number of simulation ticks');
    }
    this.stationOwner = new Int32Array(this.grid.stations.length).fill(-1);
    this.queueSpots = this.grid.stations.map((s) => this.findQueueSpots(s));
    this.racks = this.grid.stations.filter((s) => s.kind === 'rack');
    this.chargers = this.grid.stations.filter((s) => s.kind === 'charger');
    this.dockStations = layout.dockNodes.map((_, i) =>
      this.grid.stations.filter((s) => s.kind === 'dock' && s.ref === i),
    );
    this.rackRng = new Rng(deriveSeed(seed, 'racks'));
    this.orderRate = config.rackOrderRate;
    this.nextOrderAt = this.orderRate > 0 ? this.rackRng.exponential(this.orderRate) : Infinity;

    // Homes alternate between the two depots so both stay in use.
    const north = parking.filter((s) => s.z < 0);
    const south = parking.filter((s) => s.z > 0);
    const fleetRng = new Rng(deriveSeed(seed, 'fleet'));
    for (let i = 0; i < config.robots; i++) {
      const home = (i % 2 === 0 ? north : south)[Math.floor(i / 2)] as Station;
      const motion = new RobotMotion(
        this.grid,
        config.motion,
        home.cell,
        (home.face * Math.PI) / 2,
      );
      this.stationOwner[home.id] = i;
      this.table.hold(home.cell, 0, i);
      this.robots.push({
        id: i,
        home,
        motion,
        battery: 40 + fleetRng.next() * 60,
        stage: 'parked',
        job: null,
        load: [],
        station: home,
        waitingFor: null,
        spot: -1,
        goalCell: home.cell,
        needsPlan: false,
        cells: [home.cell],
        planStart: 0,
        modes: [],
        modeStart: 0,
        dwellUntil: 0,
        failures: 0,
        failingSince: 0,
        evadeFrom: null,
        evading: false,
        evadeGoal: -1,
        resumeAt: 0,
        watchedAt: -Infinity,
        reportedEpisode: -1,
        stuckSince: -1,
        defectUntil: -1,
        stageBeforeDefect: 'parked',
        dwellLeftAtDefect: 0,
        lastStageChange: 0,
        jobsDone: 0,
        delivered: 0,
      });
    }
  }

  get stepSeconds(): number {
    return this.config.motion.stepSeconds;
  }

  setRackOrderRate(rate: number): void {
    this.orderRate = Math.max(0, rate);
  }

  get rackOrderRate(): number {
    return this.orderRate;
  }

  /** Puts a robot out of order until `until` (seconds). It stops at its next safe cell. */
  setDefect(robotId: number, until: number): void {
    const r = this.robots[robotId];
    if (!r) throw new Error(`Unknown robot ${robotId}`);
    r.defectUntil = until;
  }

  /** True while a robot is reported stuck (no path for STUCK_SECONDS, not repaired yet). */
  isStuck(r: Robot): boolean {
    return r.failures > 0 && r.stuckSince === r.failingSince;
  }

  /** Remaining cells of a robot's route from step `step` on (consecutive duplicates removed). */
  route(r: Robot, step: number, max = 32): number[] {
    const out: number[] = [];
    const from = Math.max(0, step - r.planStart);
    for (let i = from; i < r.cells.length && out.length < max; i++) {
      const c = r.cells[i] as number;
      if (out[out.length - 1] !== c) out.push(c);
    }
    return out;
  }

  // ---------------------------------------------------------------- checkpoints

  /**
   * Everything that changes while the fleet runs. Packets are written as ids
   * (the world writes them once), bypass lanes as their index; the floor,
   * the stations and the queue spots never change and are not stored.
   */
  save(w: StateWriter): void {
    w.int(this.k);
    w.float(this.nextOrderAt);
    w.int(this.nextOrderId);
    w.float(this.orderRate);
    w.int(this.rackRng.getState());
    w.ints32(this.stationOwner);
    w.int(this.spotOwner.size);
    for (const [cell, robot] of this.spotOwner) {
      w.int(cell);
      w.int(robot);
    }
    for (const v of Object.values(this.stats)) w.float(v);
    for (const v of Object.values(this.planner.stats)) w.float(v);
    this.table.save(w);
    w.int(this.orders.length);
    for (const o of this.orders) saveOrder(w, o);
    for (const r of this.robots) this.saveRobot(w, r);
  }

  load(r: StateReader, packet: (id: number) => Packet): void {
    this.k = r.int();
    this.nextOrderAt = r.float();
    this.nextOrderId = r.int();
    this.orderRate = r.float();
    this.rackRng.setState(r.int());
    this.stationOwner.set(r.ints32());
    this.spotOwner.clear();
    for (let i = r.int(); i > 0; i--) this.spotOwner.set(r.int(), r.int());
    const stats = this.stats as unknown as Record<string, number>;
    for (const key of Object.keys(stats)) stats[key] = r.float();
    const plannerStats = this.planner.stats as unknown as Record<string, number>;
    for (const key of Object.keys(plannerStats)) plannerStats[key] = r.float();
    this.table.load(r);
    this.orders.length = 0;
    for (let i = r.int(); i > 0; i--) this.orders.push(this.loadOrder(r, packet));
    for (const robot of this.robots) this.loadRobot(r, robot, packet);
  }

  private saveRobot(w: StateWriter, r: Robot): void {
    w.float(r.battery);
    w.pick(r.stage, ROBOT_STAGES);
    const job = r.job;
    w.int(job ? JOB_KINDS.indexOf(job.kind) : -1);
    if (job?.kind === 'rack') saveOrder(w, job.order);
    else if (job?.kind === 'bypass') w.int(job.lane.id);
    else if (job?.kind === 'goto') w.int(job.cell);
    w.ints32(r.load.map((p) => p.id));
    w.int(r.station ? r.station.id : -1);
    w.int(r.waitingFor ? r.waitingFor.id : -1);
    w.int(r.spot);
    w.int(r.goalCell);
    w.bool(r.needsPlan);
    w.ints32(r.cells);
    w.int(r.planStart);
    w.ints32(r.modes);
    w.int(r.modeStart);
    w.float(r.dwellUntil);
    w.int(r.failures);
    w.float(r.failingSince);
    w.bool(r.evadeFrom !== null);
    if (r.evadeFrom) w.ints32([...r.evadeFrom]);
    w.bool(r.evading);
    w.int(r.evadeGoal);
    w.float(r.resumeAt);
    w.float(r.watchedAt);
    w.float(r.reportedEpisode);
    w.float(r.stuckSince);
    w.float(r.defectUntil);
    w.pick(r.stageBeforeDefect, ROBOT_STAGES);
    w.float(r.dwellLeftAtDefect);
    w.float(r.lastStageChange);
    w.int(r.jobsDone);
    w.int(r.delivered);
    r.motion.save(w);
  }

  private loadRobot(rd: StateReader, r: Robot, packet: (id: number) => Packet): void {
    const stations = this.grid.stations;
    r.battery = rd.float();
    r.stage = rd.pick(ROBOT_STAGES);
    const kind = rd.int();
    switch (JOB_KINDS[kind]) {
      case 'rack':
        r.job = { kind: 'rack', order: this.loadOrder(rd, packet) };
        break;
      case 'bypass':
        r.job = { kind: 'bypass', lane: this.host.lanes[rd.int()] as BypassLane };
        break;
      case 'goto':
        r.job = { kind: 'goto', cell: rd.int() };
        break;
      case 'charge':
        r.job = { kind: 'charge' };
        break;
      case 'park':
        r.job = { kind: 'park' };
        break;
      default:
        r.job = null;
    }
    r.load = rd.ints32().map(packet);
    const station = rd.int();
    r.station = station >= 0 ? (stations[station] as Station) : null;
    const waitingFor = rd.int();
    r.waitingFor = waitingFor >= 0 ? (stations[waitingFor] as Station) : null;
    r.spot = rd.int();
    r.goalCell = rd.int();
    r.needsPlan = rd.bool();
    r.cells = rd.ints32();
    r.planStart = rd.int();
    r.modes = rd.ints32();
    r.modeStart = rd.int();
    r.dwellUntil = rd.float();
    r.failures = rd.int();
    r.failingSince = rd.float();
    r.evadeFrom = rd.bool() ? new Set(rd.ints32()) : null;
    r.evading = rd.bool();
    r.evadeGoal = rd.int();
    r.resumeAt = rd.float();
    r.watchedAt = rd.float();
    r.reportedEpisode = rd.float();
    r.stuckSince = rd.float();
    r.defectUntil = rd.float();
    r.stageBeforeDefect = rd.pick(ROBOT_STAGES);
    r.dwellLeftAtDefect = rd.float();
    r.lastStageChange = rd.float();
    r.jobsDone = rd.int();
    r.delivered = rd.int();
    r.motion.load(rd, r.cells, r.planStart);
  }

  private loadOrder(r: StateReader, packet: (id: number) => Packet): RackOrder {
    return {
      id: r.int(),
      face: this.grid.stations[r.int()] as Station,
      dock: r.int(),
      packets: r.ints32().map(packet),
    };
  }

  // ---------------------------------------------------------------- scenarios

  /**
   * Scenario setup (tests, scenario lab, cinema mode): moves an idle robot to
   * `cell`, at rest and facing `heading`, without driving there.
   */
  place(robotId: number, cell: number, heading: number): void {
    const r = this.robot(robotId);
    if (r.stage !== 'parked' && r.stage !== 'toPark')
      throw new Error('only idle robots can be placed');
    if (!this.grid.passable(cell)) throw new Error(`cell ${cell} is not floor`);
    const holder = this.table.holder(cell);
    if (holder >= 0 && holder !== r.id) throw new Error(`cell ${cell} is taken by robot ${holder}`);
    this.releaseStation(r);
    this.table.release(r.id, -1);
    this.table.hold(cell, this.k, r.id);
    r.motion.teleport(cell, (heading * Math.PI) / 2);
    r.cells = [cell];
    r.planStart = this.k;
    r.modes = [];
    r.goalCell = cell;
    r.needsPlan = false;
    r.job = null;
    this.setStage(r, 'toPark', this.k * this.stepSeconds);
  }

  /** Scenario setup: sends a robot to `cell`; it stops there and is free again. */
  sendTo(robotId: number, cell: number): void {
    const r = this.robot(robotId);
    if (r.stage === 'defect') throw new Error('a broken robot cannot move');
    if (!this.grid.passable(cell)) throw new Error(`cell ${cell} is not floor`);
    this.releaseStation(r);
    r.job = { kind: 'goto', cell };
    this.setStage(r, 'toPoint', this.k * this.stepSeconds);
    r.goalCell = cell;
    r.needsPlan = true;
  }

  /** Scenario setup: loads `count` new packets on a robot and sends it to deliver them to a dock. */
  deliver(robotId: number, dock: number, count: number): void {
    const r = this.robot(robotId);
    if (r.stage === 'defect') throw new Error('a broken robot cannot move');
    const now = this.k * this.stepSeconds;
    const packets = Array.from({ length: count }, () => this.host.createRackPacket(dock, now));
    for (const p of packets) p.state = 'robot';
    const order: RackOrder = {
      id: this.nextOrderId++,
      face: this.racks[0] as Station,
      dock,
      packets,
    };
    this.stats.rackOrdersCreated++;
    this.releaseStation(r);
    r.job = { kind: 'rack', order };
    r.load = packets.slice();
    this.goTo(r, this.pickDock(r, dock), 'toDrop', now);
  }

  private robot(id: number): Robot {
    const r = this.robots[id];
    if (!r) throw new Error(`Unknown robot ${id}`);
    return r;
  }

  update(tick: number, now: number, dt: number): void {
    this.generateRackOrders(now);
    for (const r of this.robots) this.updateRobot(r, now, dt);
    if (tick % this.ticksPerStep === 0) this.planningRound(tick / this.ticksPerStep, now);
  }

  // ---------------------------------------------------------------- orders

  private generateRackOrders(now: number): void {
    while (this.nextOrderAt <= now && this.orderRate > 0) {
      const face = this.racks[this.rackRng.int(this.racks.length)] as Station;
      const dock = this.rackRng.int(this.layout.dockNodes.length);
      const n = 1 + this.rackRng.int(4);
      const packets = Array.from({ length: n }, () =>
        this.host.createRackPacket(dock, this.nextOrderAt),
      );
      this.orders.push({ id: this.nextOrderId++, face, dock, packets });
      this.stats.rackOrdersCreated++;
      this.nextOrderAt += this.rackRng.exponential(this.orderRate);
    }
    if (this.orderRate <= 0) this.nextOrderAt = Infinity;
  }

  // ---------------------------------------------------------------- per tick

  private updateRobot(r: Robot, now: number, dt: number): void {
    const before = r.motion.odometer;
    r.motion.update(now, dt);
    const meters = r.motion.odometer - before;
    const c = this.config;
    if (r.stage === 'charging') {
      r.battery = Math.min(100, r.battery + c.chargePerSecond * dt);
    } else {
      r.battery -= meters * (c.batteryPerMeter + (r.load.length ? c.batteryLoadedPerMeter : 0));
      r.battery -= c.batteryIdlePerSecond * dt;
      if (r.battery <= 0) {
        if (r.battery > -1e9) this.stats.batteryDepleted++;
        r.battery = 0;
      }
    }
    if (r.stage === 'defect') return;

    // Arrival at the goal of the current leg.
    const end = r.planStart + r.cells.length - 1;
    const travelling =
      r.stage === 'toPark' ||
      r.stage === 'toPickup' ||
      r.stage === 'toDrop' ||
      r.stage === 'toCharger' ||
      r.stage === 'toPoint';
    const target = r.evading ? r.evadeGoal : r.goalCell;
    if (
      !r.needsPlan &&
      r.cells[r.cells.length - 1] === target &&
      r.motion.arrived &&
      now >= end * this.stepSeconds - 1e-9
    ) {
      if (r.evading) {
        // Out of the way: give the blocked robot a few steps, then resume.
        r.evading = false;
        r.evadeFrom = null;
        r.evadeGoal = -1;
        r.resumeAt = now + 4 * this.stepSeconds;
        r.needsPlan = this.here(r) !== r.goalCell;
      } else if (travelling && !r.waitingFor) {
        this.arrive(r, now);
      }
    }
    if ((r.stage === 'loading' || r.stage === 'unloading') && now >= r.dwellUntil)
      this.finishDwell(r, now);
    if (r.stage === 'charging' && r.battery >= c.fullBattery) this.finishJob(r, now);
  }

  private setStage(r: Robot, stage: RobotStage, now: number): void {
    if (r.stage === stage) return;
    r.lastStageChange = now;
    r.stage = stage;
    this.onStage?.(r.id, stage, now);
  }

  private arrive(r: Robot, now: number): void {
    const c = this.config;
    switch (r.stage) {
      case 'toPickup': {
        const job = r.job;
        let n = 0;
        if (job?.kind === 'rack') n = job.order.packets.length;
        else if (job?.kind === 'bypass') n = Math.min(c.capacity, job.lane.pickup.length);
        if (n === 0) {
          this.finishJob(r, now);
          return;
        }
        r.dwellUntil = now + c.loadBaseSeconds + c.loadPerPacketSeconds * n;
        this.setStage(r, 'loading', now);
        return;
      }
      case 'toDrop':
        r.dwellUntil = now + c.loadBaseSeconds + c.loadPerPacketSeconds * r.load.length;
        this.setStage(r, 'unloading', now);
        return;
      case 'toCharger':
        this.setStage(r, 'charging', now);
        return;
      case 'toPark':
        this.setStage(r, 'parked', now);
        r.job = null;
        return;
      case 'toPoint':
        this.finishJob(r, now);
        return;
      default:
        return;
    }
  }

  private finishDwell(r: Robot, now: number): void {
    const job = r.job;
    if (r.stage === 'loading') {
      if (job?.kind === 'rack') {
        for (const p of job.order.packets) {
          p.state = 'robot';
          // On the shelf since the order: waiting for this robot (a measure only).
          p.waited += now - p.createdAt;
        }
        r.load = job.order.packets.slice();
        this.goTo(r, this.pickDock(r, job.order.dock), 'toDrop', now);
      } else if (job?.kind === 'bypass') {
        r.load = this.host.takeFromLane(job.lane, this.config.capacity);
        for (const p of r.load) p.state = 'robot';
        if (r.load.length === 0) {
          this.finishJob(r, now);
          return;
        }
        this.goTo(r, job.lane.dropStation, 'toDrop', now);
      } else {
        this.finishJob(r, now);
      }
      return;
    }
    // Unloading: hand the packets over, or try again in a second.
    let done = true;
    if (job?.kind === 'rack') {
      done = this.host.deliverToDock(job.order.dock, r.load, now);
      if (done) this.stats.rackOrdersDone++;
    } else if (job?.kind === 'bypass') {
      done = this.host.dropIntoLane(job.lane, r.load);
      if (done) job.lane.carried += r.load.length;
    }
    if (!done) {
      r.dwellUntil = now + this.stepSeconds;
      return;
    }
    r.delivered += r.load.length;
    r.load = [];
    this.finishJob(r, now);
  }

  private finishJob(r: Robot, now: number): void {
    if (r.job && r.job.kind !== 'park' && r.job.kind !== 'goto') {
      r.jobsDone++;
      this.stats.jobsDone++;
    }
    r.job = null;
    this.releaseStation(r);
    // Stay put; the next planning round gives a new job or sends it home.
    this.setStage(r, r.cells[r.cells.length - 1] === r.home.cell ? 'parked' : 'toPark', now);
    r.goalCell = r.cells[r.cells.length - 1] as number;
    r.needsPlan = false;
  }

  // ---------------------------------------------------------------- stations

  private findQueueSpots(s: Station): number[] {
    const dist = this.grid.distanceMap(s.cell);
    const candidates: number[] = [];
    for (let cell = 0; cell < this.grid.cellCount; cell++) {
      if (!this.grid.holdable[cell] || (this.grid.stationAt[cell] as number) >= 0) continue;
      const d = dist[cell] as number;
      if (d >= 2 && d <= 10) candidates.push(cell);
    }
    candidates.sort((a, b) => (dist[a] as number) - (dist[b] as number) || a - b);
    return candidates.slice(0, QUEUE_SPOTS);
  }

  /**
   * A station or queue spot is free for `r` when nobody else owns it and
   * nobody else is standing on it. Ownership is released as soon as a robot
   * is done, but that robot leaves the cell only when its next plan starts;
   * until then the cell is still held in the reservation table, and planning
   * toward it would just fail.
   */
  private cellFree(cell: number, r: Robot | null): boolean {
    const h = this.table.holder(cell);
    return h < 0 || (r !== null && h === r.id);
  }

  private stationFree(st: Station, r: Robot | null): boolean {
    const owner = this.stationOwner[st.id] as number;
    return (owner < 0 || (r !== null && owner === r.id)) && this.cellFree(st.cell, r);
  }

  private releaseStation(r: Robot): void {
    if (r.station && this.stationOwner[r.station.id] === r.id) this.stationOwner[r.station.id] = -1;
    r.station = null;
    this.releaseSpot(r);
    r.waitingFor = null;
  }

  private releaseSpot(r: Robot): void {
    if (r.spot >= 0 && this.spotOwner.get(r.spot) === r.id) this.spotOwner.delete(r.spot);
    r.spot = -1;
  }

  /** Sends the robot to `station`, or to a queue spot next to it when it is busy. */
  private goTo(r: Robot, station: Station, stage: RobotStage, now: number): void {
    if (r.station && r.station !== station && this.stationOwner[r.station.id] === r.id) {
      this.stationOwner[r.station.id] = -1;
    }
    r.station = null;
    this.setStage(r, stage, now);
    if (this.stationFree(station, r)) {
      this.stationOwner[station.id] = r.id;
      r.station = station;
      r.waitingFor = null;
      this.releaseSpot(r);
      r.goalCell = station.cell;
      r.needsPlan = true;
      return;
    }
    r.waitingFor = station;
    if (r.spot < 0) {
      const spot = (this.queueSpots[station.id] as number[]).find(
        (c) => !this.spotOwner.has(c) && this.cellFree(c, r),
      );
      if (spot !== undefined) {
        this.spotOwner.set(spot, r.id);
        r.spot = spot;
      }
    }
    // Without a free spot the robot waits where it is.
    r.goalCell = r.spot >= 0 ? r.spot : this.currentCell(r);
    r.needsPlan = r.goalCell !== this.currentCell(r) || r.cells.length > 1;
  }

  private pickDock(r: Robot, dock: number): Station {
    const options = this.dockStations[dock] as Station[];
    const cell = this.currentCell(r);
    const free = options.filter((s) => this.stationFree(s, r));
    const pool = free.length ? free : options;
    return pool.reduce((best, s) =>
      (this.grid.distanceMap(s.cell)[cell] as number) <
      (this.grid.distanceMap(best.cell)[cell] as number)
        ? s
        : best,
    );
  }

  /** Last cell of the robot's current plan (where it will stop). */
  private currentCell(r: Robot): number {
    return r.cells[r.cells.length - 1] as number;
  }

  /** Cell the robot occupies at the current step. */
  private here(r: Robot): number {
    return this.cellAt(r, this.k);
  }

  // ---------------------------------------------------------------- planning round

  private planningRound(k: number, now: number): void {
    this.k = k;
    this.table.advanceTo(k);
    this.updateDefects(k, now);
    this.retryQueues(now);
    this.assignJobs(now);

    const queue = this.robots
      .filter((r) => r.needsPlan && r.stage !== 'defect' && now >= r.resumeAt)
      .sort(
        (a, b) =>
          Number(!!b.evadeFrom) - Number(!!a.evadeFrom) || b.failures - a.failures || a.id - b.id,
      );
    this.drain(queue, k);

    for (const r of this.robots) {
      if (r.failures > 0) {
        this.stats.maxFailingSeconds = Math.max(this.stats.maxFailingSeconds, now - r.failingSince);
        if (
          r.stage !== 'defect' &&
          r.stuckSince !== r.failingSince &&
          now - r.failingSince >= STUCK_SECONDS - 1e-9
        ) {
          r.stuckSince = r.failingSince;
          this.host.notify('robot-stuck', `Robô ${r.id + 1} sem caminho há ${STUCK_SECONDS} s`, [
            r.id,
          ]);
        }
        if (this.config.stepAside && r.failures >= 4 && r.failures % 2 === 0) {
          this.requestEvasion(r, k);
        }
      }
    }
    this.watchdog(k, now);
  }

  /** Plans the robots in `queue` in order; robots bumped by a failed plan join the end. */
  private drain(queue: Robot[], k: number): void {
    const passes = new Map<number, number>();
    while (queue.length) {
      const r = queue.shift() as Robot;
      const n = (passes.get(r.id) ?? 0) + 1;
      passes.set(r.id, n);
      for (const b of this.planRobot(r, k, n > 3)) {
        const other = this.robots[b] as Robot;
        other.needsPlan = true;
        this.stats.bumps++;
        if (!queue.includes(other)) queue.push(other);
      }
    }
  }

  /**
   * Plans `r` from its commit point. Returns robots that must replan because
   * `r` had to stop and hold a cell they planned to use later.
   */
  private planRobot(r: Robot, k: number, giveUp: boolean): number[] {
    const commit = this.commitPoint(r, k);
    const goal = r.evadeFrom ? { cell: -1, avoid: r.evadeFrom } : { cell: r.goalCell };
    const plan = giveUp ? null : this.planner.plan(r.id, commit.start, goal);
    if (plan) {
      this.stats.plans++;
      this.stats.expansions += plan.expansions;
      this.planner.commit(r.id, plan);
      const cells = commit.prefix.concat(plan.cells.slice(1));
      this.follow(r, cells, commit.prefixStart, k);
      r.modes = replayModes(this.grid, plan.cells, startMode(commit.start));
      r.modeStart = plan.startStep;
      r.needsPlan = false;
      if (r.failures > 0 && r.stuckSince === r.failingSince) {
        const waited = Math.round(k * this.stepSeconds - r.failingSince);
        this.host.notify('robot-moving', `Robô ${r.id + 1} voltou a andar após ${waited} s`, [
          r.id,
        ]);
      }
      r.failures = 0;
      if (r.evadeFrom) {
        r.evading = true;
        r.evadeGoal = plan.cells[plan.cells.length - 1] as number;
      }
      return [];
    }
    // No path: stop on the committed cell and keep it.
    this.stats.failedPlans++;
    if (r.failures === 0) r.failingSince = k * this.stepSeconds;
    r.failures++;
    // An evasion that cannot be done is simply dropped.
    r.evadeFrom = null;
    const bumped = this.holdHere(r, commit.start.cell, commit.start.step);
    this.follow(r, commit.prefix, commit.prefixStart, k);
    return bumped;
  }

  /**
   * Makes `r` stop and hold `cell` from `step`, dropping its later plan.
   * Returns the robots that planned to use the cell afterwards: their later
   * reservations, or a hold they would only start in the future (they are
   * still at least two steps away), must be replanned.
   */
  private holdHere(r: Robot, cell: number, step: number): number[] {
    this.table.release(r.id, step);
    const bumped = this.table.conflictsWithHold(cell, step, r.id);
    const holder = this.table.holder(cell);
    if (holder >= 0 && holder !== r.id) {
      this.table.cancelHold(holder);
      if (!bumped.includes(holder)) bumped.push(holder);
    }
    this.table.hold(cell, step, r.id);
    return bumped;
  }

  private follow(r: Robot, cells: number[], start: number, k: number): void {
    r.cells = cells;
    r.planStart = start;
    r.motion.setPlan(cells, start, k);
  }

  private cellAt(r: Robot, step: number): number {
    const i = Math.min(Math.max(step - r.planStart, 0), r.cells.length - 1);
    return r.cells[i] as number;
  }

  /**
   * Where and in which motion state the robot will be when a new plan can
   * start. A moving robot commits two steps ahead: the shape of its path near
   * the next cell (arc or not) depends on where it goes after it, and changing
   * that while the robot is already approaching would ask for harsher braking
   * than allowed. Two steps leave more than a meter to adapt.
   */
  private commitPoint(
    r: Robot,
    k: number,
  ): { start: PlanStart; prefix: number[]; prefixStart: number } {
    const end = r.planStart + r.cells.length - 1;
    const prev = this.cellAt(r, k - 1);
    const cur = this.cellAt(r, k);
    if (end <= k) {
      // At rest on the last cell (it may still be braking into it).
      let heading = headingIndex(r.motion.heading);
      if (prev !== cur) heading = directionBetween(this.grid, prev, cur);
      return {
        start: { cell: cur, step: k, heading, moving: false, waited: 0 },
        prefix: [prev, cur],
        prefixStart: k - 1,
      };
    }
    const next = this.cellAt(r, k + 1);
    if (end === k + 1) {
      // It is about to stop on `next`: start from there, at rest.
      const mode = this.modeAt(r, k + 1, cur, next);
      const heading = mode < 4 ? mode : Math.floor((mode - 4) / 3);
      const waited = mode < 4 ? 0 : (mode - 4) % 3;
      return {
        start: { cell: next, step: k + 1, heading, moving: false, waited },
        prefix: [prev, cur, next],
        prefixStart: k - 1,
      };
    }
    const after = this.cellAt(r, k + 2);
    const mode = this.modeAt(r, k + 2, next, after);
    const start: PlanStart =
      mode < 4
        ? { cell: after, step: k + 2, heading: mode, moving: true, waited: 0 }
        : {
            cell: after,
            step: k + 2,
            heading: Math.floor((mode - 4) / 3),
            moving: false,
            waited: (mode - 4) % 3,
          };
    return { start, prefix: [prev, cur, next, after], prefixStart: k - 1 };
  }

  /** Planner mode at `step` from the latest plan, or rebuilt from the last move `a`→`b`. */
  private modeAt(r: Robot, step: number, a: number, b: number): number {
    const idx = step - r.modeStart;
    if (idx >= 0 && idx < r.modes.length) return r.modes[idx] as number;
    return a !== b ? directionBetween(this.grid, a, b) : 4 + headingIndex(r.motion.heading) * 3;
  }

  // ---------------------------------------------------------------- jobs

  private available(r: Robot): boolean {
    return (
      r.stage !== 'defect' &&
      !r.evading &&
      (r.job === null || r.job.kind === 'park') &&
      r.battery >= this.config.lowBattery
    );
  }

  private distance(station: Station, r: Robot): number {
    return this.grid.distanceMap(station.cell)[this.here(r)] as number;
  }

  private nearestAvailable(station: Station): Robot | null {
    let best: Robot | null = null;
    let bestD = UNREACHABLE;
    for (const r of this.robots) {
      if (!this.available(r)) continue;
      const d = this.distance(station, r);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  private assign(r: Robot, job: Job, station: Station, stage: RobotStage, now: number): void {
    // Leaving home (or a finished job's station) frees it for others.
    this.releaseStation(r);
    r.job = job;
    this.goTo(r, station, stage, now);
  }

  private retryQueues(now: number): void {
    for (const r of this.robots) {
      if (!r.waitingFor || r.stage === 'defect') continue;
      if (this.stationFree(r.waitingFor, r)) this.goTo(r, r.waitingFor, r.stage, now);
    }
  }

  private assignJobs(now: number): void {
    const c = this.config;
    // 1. Low batteries go charging (idle robots top up a little earlier).
    for (const r of this.robots) {
      if (r.stage === 'defect' || r.evading || (r.job && r.job.kind !== 'park')) continue;
      if (r.battery >= c.lowBattery + 10) continue;
      const free = this.chargers.filter((s) => this.stationFree(s, null));
      if (free.length === 0) continue;
      const charger = free.reduce((a, b) => (this.distance(a, r) <= this.distance(b, r) ? a : b));
      this.assign(r, { kind: 'charge' }, charger, 'toCharger', now);
    }
    // 2. Bypass trips around broken conveyors.
    for (const lane of this.host.lanes) {
      if (!lane.active || lane.pickup.length === 0) continue;
      const working = this.robots.filter(
        (r) => r.job?.kind === 'bypass' && r.job.lane === lane,
      ).length;
      const wanted = Math.min(c.maxRobotsPerLane, Math.ceil(lane.pickup.length / c.capacity) + 1);
      if (working >= wanted) continue;
      const r = this.nearestAvailable(lane.pickupStation);
      if (r) this.assign(r, { kind: 'bypass', lane }, lane.pickupStation, 'toPickup', now);
    }
    // 3. Stock orders, oldest first, when their rack face is free.
    for (let i = 0; i < this.orders.length; i++) {
      const order = this.orders[i] as RackOrder;
      if (!this.stationFree(order.face, null)) continue;
      const r = this.nearestAvailable(order.face);
      if (!r) break;
      this.orders.splice(i--, 1);
      this.assign(r, { kind: 'rack', order }, order.face, 'toPickup', now);
    }
    // 4. Everyone else goes home.
    for (const r of this.robots) {
      if (r.stage === 'defect' || r.evading || r.job || r.waitingFor) continue;
      if (this.currentCell(r) === r.home.cell && !r.needsPlan) {
        if (r.stage !== 'parked') this.setStage(r, 'parked', now);
        r.station = r.home;
        this.stationOwner[r.home.id] = r.id;
        continue;
      }
      r.job = { kind: 'park' };
      this.goTo(r, r.home, 'toPark', now);
    }
  }

  // ---------------------------------------------------------------- failures

  private updateDefects(k: number, now: number): void {
    for (const r of this.robots) {
      if (r.stage !== 'defect' && r.defectUntil > now) {
        // Stop on the committed cell, like a failed plan, and wait for repair.
        r.stageBeforeDefect = r.stage;
        r.dwellLeftAtDefect = Math.max(0, r.dwellUntil - now);
        const commit = this.commitPoint(r, k);
        for (const b of this.holdHere(r, commit.start.cell, commit.start.step)) {
          const other = this.robots[b] as Robot;
          other.needsPlan = true;
          this.stats.bumps++;
        }
        this.follow(r, commit.prefix, commit.prefixStart, k);
        r.evading = false;
        r.evadeFrom = null;
        this.setStage(r, 'defect', now);
      } else if (r.stage === 'defect' && r.defectUntil <= now) {
        r.defectUntil = -1;
        this.setStage(r, r.stageBeforeDefect, now);
        r.dwellUntil = now + r.dwellLeftAtDefect;
        // Resume the leg it was on (or at least re-check where it stands).
        r.needsPlan = this.currentCell(r) !== r.goalCell;
      }
    }
  }

  /**
   * `r`'s shortest route to its goal on the empty floor, from where it stands
   * (the same route for everyone who looks, so requests and the watchdog agree).
   */
  private staticRoute(r: Robot, k: number): number[] {
    const dist = this.grid.distanceMap(r.goalCell);
    let cell = this.cellAt(r, k);
    const route = [cell];
    for (let guard = 0; guard < 400 && (dist[cell] as number) > 0; guard++) {
      let next = -1;
      for (let d = 0; d < 4; d++) {
        const n = this.grid.neighbor(cell, d);
        if (n >= 0 && !this.grid.blocked[n] && (dist[n] as number) < (dist[cell] as number)) {
          next = n;
          break;
        }
      }
      if (next < 0) break;
      cell = next;
      route.push(cell);
    }
    return route;
  }

  /** Asks robots standing still on `r`'s shortest route to step aside. */
  private requestEvasion(r: Robot, k: number): void {
    // Already asked to step aside itself: if both robots of a pair asked each
    // other, both would back off and meet again.
    if (r.evadeFrom || r.evading) return;
    const path = new Set(this.staticRoute(r, k));
    const inTheWay: Robot[] = [];
    for (const c of path) {
      const h = this.table.holder(c);
      if (h < 0 || h === r.id) continue;
      const other = this.robots[h] as Robot;
      const busy =
        other.stage === 'defect' ||
        other.stage === 'loading' ||
        other.stage === 'unloading' ||
        other.stage === 'charging' ||
        other.stage === 'parked' ||
        other.evading;
      // One robot that cannot move now keeps the way shut: the others would
      // step aside for nothing.
      if (busy) return;
      if (!other.evadeFrom) inTheWay.push(other);
    }
    for (const other of inTheWay) {
      other.evadeFrom = path;
      other.needsPlan = true;
      this.stats.evades++;
    }
  }

  // ---------------------------------------------------------------- watchdog

  /**
   * Supervisor for the waits that step-aside requests do not solve. It looks
   * at robots that have had no path for `watchdogSeconds`; each one waits for
   * the first robot standing on its static route (a wait-for graph with one
   * edge per robot, so cycles are found by following the edges).
   *
   *  - Cycle (robots waiting for each other): it tries a back-off for every
   *    member, without side effects, and the one that gets out of the way in
   *    the fewest steps backs off to a holdable cell off the others' routes
   *    (an empty-handed robot yields before a loaded one), and the others
   *    replan at once. It cannot block them again on its way back: it only
   *    leaves with a complete plan, and no plan crosses a robot that holds its
   *    cell. Nothing depends on the blocker accepting a request: the fleet
   *    manager plans both sides itself.
   *  - Behind a broken robot: it is sent to an equivalent station it can reach
   *    now (the other drop of the same dock). Without one it waits for the
   *    repair, which bounds the wait.
   *
   * It acts on a robot at most once per period.
   */
  private watchdog(k: number, now: number): void {
    const period = this.config.watchdogSeconds;
    if (!(period > 0)) return;
    const routes = new Map<number, number[]>();
    const waitsFor = new Map<number, number>();
    for (const r of this.robots) {
      if (r.stage === 'defect' || r.failures === 0) continue;
      if (now - r.failingSince < period - 1e-9 || now - r.watchedAt < period - 1e-9) continue;
      const route = this.staticRoute(r, k);
      routes.set(r.id, route);
      waitsFor.set(r.id, this.firstHolder(route, r));
    }
    if (routes.size === 0) return;

    // Cycles: follow each robot's single edge until it leaves the stuck set or repeats.
    const done = new Set<number>();
    for (const first of routes.keys()) {
      if (done.has(first)) continue;
      const walk: number[] = [];
      let id = first;
      while (routes.has(id) && !done.has(id) && !walk.includes(id)) {
        walk.push(id);
        id = waitsFor.get(id) as number;
      }
      const at = walk.indexOf(id);
      if (at >= 0) {
        const cycle = walk.slice(at).map((i) => this.robots[i] as Robot);
        this.breakCycle(cycle, routes, k, now);
      }
      for (const i of walk) done.add(i);
    }

    // Robots stuck behind a broken one.
    for (const [id, blocker] of waitsFor) {
      const r = this.robots[id] as Robot;
      const b = this.robots[blocker];
      if (!b || b.stage !== 'defect' || now - r.watchedAt < period - 1e-9) continue;
      this.avoidBroken(r, b, k, now);
    }
  }

  /** First robot other than `r` holding a cell of `route`, or -1. */
  private firstHolder(route: readonly number[], r: Robot): number {
    for (const c of route) {
      const h = this.table.holder(c);
      if (h >= 0 && h !== r.id) return h;
    }
    return -1;
  }

  private breakCycle(
    cycle: Robot[],
    routes: ReadonlyMap<number, number[]>,
    k: number,
    now: number,
  ): void {
    for (const r of cycle) r.watchedAt = now;
    let best: { r: Robot; steps: number; avoid: Set<number> } | null = null;
    for (const v of cycle) {
      const avoid = new Set<number>();
      for (const o of cycle) {
        if (o !== v) for (const c of routes.get(o.id) as number[]) avoid.add(c);
      }
      const plan = this.planner.plan(v.id, this.commitPoint(v, k).start, { cell: -1, avoid });
      if (!plan) continue;
      const steps = plan.cells.length;
      if (!best || steps < best.steps || (steps === best.steps && yieldsFirst(v, best.r))) {
        best = { r: v, steps, avoid };
      }
    }
    const names = listRobots(cycle);
    if (!best) {
      this.stats.cyclesStalled++;
      this.host.notify(
        'watchdog',
        `Vigia: ${names} esperam um pelo outro e nenhum consegue recuar`,
        cycle.map((r) => r.id),
      );
      return;
    }
    const v = best.r;
    const others = cycle.filter((r) => r !== v);
    for (const r of cycle) {
      r.evadeFrom = null;
      r.needsPlan = true;
    }
    v.evadeFrom = best.avoid;
    this.drain([v, ...others], k);
    this.stats.cyclesBroken++;
    this.host.notify(
      'watchdog',
      `Vigia: ${names} esperavam um pelo outro; o Robô ${v.id + 1} recuou para abrir passagem`,
      cycle.map((r) => r.id),
    );
  }

  private avoidBroken(r: Robot, broken: Robot, k: number, now: number): void {
    r.watchedAt = now;
    const job = r.job;
    if (r.stage === 'toDrop' && job?.kind === 'rack' && r.station) {
      const start = this.commitPoint(r, k).start;
      for (const alt of this.dockStations[job.order.dock] as Station[]) {
        if (alt === r.station || !this.stationFree(alt, r)) continue;
        if (!this.planner.plan(r.id, start, { cell: alt.cell })) continue;
        this.goTo(r, alt, 'toDrop', now);
        this.drain([r], k);
        this.stats.reroutes++;
        this.host.notify(
          'watchdog',
          `Vigia: Robô ${r.id + 1} vai pela outra baia da Doca ${job.order.dock + 1}; ` +
            `o Robô ${broken.id + 1}, com defeito, fecha o caminho`,
          [r.id, broken.id],
        );
        return;
      }
    }
    if (r.reportedEpisode !== r.failingSince) {
      r.reportedEpisode = r.failingSince;
      this.host.notify(
        'watchdog',
        `Vigia: Robô ${r.id + 1} sem caminho; o Robô ${broken.id + 1}, com defeito, está na rota dele`,
        [r.id, broken.id],
      );
    }
  }
}

const JOB_KINDS: readonly Job['kind'][] = ['rack', 'bypass', 'charge', 'park', 'goto'];

function saveOrder(w: StateWriter, o: RackOrder): void {
  w.int(o.id);
  w.int(o.face.id);
  w.int(o.dock);
  w.ints32(o.packets.map((p) => p.id));
}

/** Who backs off when two robots are equally quick to: empty-handed before loaded, then the higher id. */
function yieldsFirst(a: Robot, b: Robot): boolean {
  const la = a.load.length > 0 ? 1 : 0;
  const lb = b.load.length > 0 ? 1 : 0;
  return la !== lb ? la < lb : a.id > b.id;
}

/** "Robôs 3 e 7", "Robôs 3, 7 e 9". */
function listRobots(rs: readonly Robot[]): string {
  const ids = rs.map((r) => String(r.id + 1));
  const last = ids.pop() as string;
  return ids.length ? `Robôs ${ids.join(', ')} e ${last}` : `Robô ${last}`;
}

function headingIndex(radians: number): number {
  return (((Math.round(radians / (Math.PI / 2)) % 4) + 4) % 4) as number;
}

function directionBetween(grid: FloorGrid, a: number, b: number): number {
  for (let d = 0; d < 4; d++) if (grid.neighbor(a, d) === b) return d;
  return 0;
}

/** Planner mode after each step of `cells`, starting from `mode`. */
function replayModes(grid: FloorGrid, cells: readonly number[], mode: number): number[] {
  const modes = [mode];
  let m = mode;
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1] as number;
    const b = cells[i] as number;
    if (a === b) m = waitMode(m);
    else {
      const d = directionBetween(grid, a, b);
      if (!moveAllowed(m, d)) throw new Error('plan breaks the motion rules');
      m = d;
    }
    modes.push(m);
  }
  return modes;
}
