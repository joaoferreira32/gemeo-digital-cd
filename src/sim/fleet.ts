import { UNREACHABLE, createFloorGrid, type FloorGrid, type Station } from './floor';
import type { WarehouseLayout } from './layout';
import { DEFAULT_MOTION, RobotMotion, type MotionParams } from './motion';
import type { Packet } from './packet';
import { CooperativePlanner, moveAllowed, startMode, waitMode, type PlanStart } from './planner';
import { ReservationTable } from './reservations';
import { deriveSeed, Rng } from './rng';

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
 *    step aside to the nearest free holdable cell.
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
}

const QUEUE_SPOTS = 3;

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
  };
  readonly ticksPerStep: number;
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
    if (r.stage !== stage) r.lastStageChange = now;
    r.stage = stage;
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
        for (const p of job.order.packets) p.state = 'robot';
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

    for (const r of this.robots) {
      if (r.failures > 0) {
        this.stats.maxFailingSeconds = Math.max(this.stats.maxFailingSeconds, now - r.failingSince);
        if (r.failures >= 4 && r.failures % 2 === 0) this.requestEvasion(r, k);
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
