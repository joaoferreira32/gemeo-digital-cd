import type { FloorGrid } from './floor';
import type { StateReader, StateWriter } from './state';

/**
 * Continuous motion of a robot following a timed cell plan.
 *
 * The plan says where the robot should be at each step boundary (a cell
 * center, or the middle of the arc when it turns there without stopping).
 * Between boundaries that reference moves at constant speed. The robot is a
 * point mass on that path with acceleration, braking, a speed limit in turns
 * (v = √(a_lat · r)) and rotation in place when it stops to change direction.
 *
 * Two rules keep the reservations valid: the robot is never ahead of the
 * reference (it cannot enter a cell before its reserved time), and it brakes
 * early enough to stop exactly where the plan stops. Being slightly behind
 * is fine: the reservation table leaves a one-step margin for that.
 */
export interface MotionParams {
  /** Seconds per planner step (one cell move). */
  stepSeconds: number;
  vMax: number;
  accel: number;
  decel: number;
  turnRadius: number;
  /** Lateral acceleration allowed in turns; sets the turn speed √(a_lat · r). */
  lateralAccel: number;
  /** Rotation speed in place, rad/s. */
  turnRate: number;
}

export const DEFAULT_MOTION: MotionParams = {
  stepSeconds: 1,
  vMax: 1.6,
  accel: 2.0,
  decel: 2.5,
  turnRadius: 0.5,
  lateralAccel: 1.2,
  turnRate: Math.PI,
};

interface Piece {
  s0: number;
  len: number;
  arc: boolean;
  // Line: start point and unit direction.
  x0: number;
  z0: number;
  dx: number;
  dz: number;
  // Arc: center, start angle and signed sweep.
  cx: number;
  cz: number;
  a0: number;
  sweep: number;
}

const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
] as const;

function dirBetween(ax: number, az: number, bx: number, bz: number): number {
  if (bx > ax) return 0;
  if (bz > az) return 1;
  if (bx < ax) return 2;
  return 3;
}

/** Geometry and reference timeline built from a timed cell sequence. */
export class PathTimeline {
  readonly pieces: Piece[] = [];
  /** Reference arc length at each step boundary: anchors[i] belongs to step startStep + i. */
  readonly anchors: number[] = [];
  /** Arc lengths where the reference comes to rest (waits and the end), ascending. */
  readonly stops: number[] = [];
  readonly length: number;

  constructor(
    grid: FloorGrid,
    readonly cells: readonly number[],
    readonly startStep: number,
    r: number,
  ) {
    // Waypoints = distinct consecutive cells with the step range spent on each.
    const wx: number[] = [];
    const wz: number[] = [];
    const first: number[] = [];
    const last: number[] = [];
    cells.forEach((cell, i) => {
      if (i > 0 && cell === cells[i - 1]) {
        last[last.length - 1] = i;
        return;
      }
      wx.push(grid.x(cell));
      wz.push(grid.z(cell));
      first.push(i);
      last.push(i);
    });
    const n = wx.length;
    const stop = (j: number) => j === n - 1 || (last[j] as number) > (first[j] as number);
    const dirIn = (j: number) =>
      dirBetween(wx[j - 1] as number, wz[j - 1] as number, wx[j] as number, wz[j] as number);
    const dirOut = (j: number) =>
      dirBetween(wx[j] as number, wz[j] as number, wx[j + 1] as number, wz[j + 1] as number);
    const hasArc = (j: number) => j > 0 && j < n - 1 && !stop(j) && dirIn(j) !== dirOut(j);

    const anchorOf: number[] = new Array<number>(n).fill(0);
    let s = 0;
    for (let j = 0; j < n; j++) {
      if (j === 0) {
        anchorOf[0] = 0;
        continue;
      }
      const din = DIRS[dirIn(j)] as readonly [number, number];
      const startX =
        (wx[j - 1] as number) +
        (hasArc(j - 1) ? r * (DIRS[dirOut(j - 1)] as readonly number[])[0]! : 0);
      const startZ =
        (wz[j - 1] as number) +
        (hasArc(j - 1) ? r * (DIRS[dirOut(j - 1)] as readonly number[])[1]! : 0);
      const endX = (wx[j] as number) - (hasArc(j) ? r * din[0] : 0);
      const endZ = (wz[j] as number) - (hasArc(j) ? r * din[1] : 0);
      const lineLen = Math.hypot(endX - startX, endZ - startZ);
      if (lineLen > 1e-9) {
        this.pieces.push({
          s0: s,
          len: lineLen,
          arc: false,
          x0: startX,
          z0: startZ,
          dx: (endX - startX) / lineLen,
          dz: (endZ - startZ) / lineLen,
          cx: 0,
          cz: 0,
          a0: 0,
          sweep: 0,
        });
        s += lineLen;
      }
      if (hasArc(j)) {
        const dout = DIRS[dirOut(j)] as readonly [number, number];
        // Arc tangent to the incoming line at A = C - r·u, center O = A + r·v.
        const cx = endX + r * dout[0];
        const cz = endZ + r * dout[1];
        const a0 = Math.atan2(endZ - cz, endX - cx);
        const cross = -dout[0] * din[1] + dout[1] * din[0];
        const sweep = cross > 0 ? Math.PI / 2 : -Math.PI / 2;
        const len = (r * Math.PI) / 2;
        this.pieces.push({ s0: s, len, arc: true, x0: 0, z0: 0, dx: 0, dz: 0, cx, cz, a0, sweep });
        anchorOf[j] = s + len / 2;
        s += len;
      } else {
        anchorOf[j] = s;
      }
    }
    this.length = s;
    for (let j = 0; j < n; j++) {
      for (let i = first[j] as number; i <= (last[j] as number); i++)
        this.anchors[i] = anchorOf[j] as number;
      if (stop(j)) this.stops.push(anchorOf[j] as number);
    }
  }

  get endStep(): number {
    return this.startStep + this.anchors.length - 1;
  }

  /** Reference arc length at time `t` (seconds) and its speed. */
  reference(
    t: number,
    stepSeconds: number,
    out: { s: number; v: number },
  ): { s: number; v: number } {
    const k = t / stepSeconds - this.startStep;
    const lastI = this.anchors.length - 1;
    if (k <= 0) {
      out.s = this.anchors[0] as number;
      out.v = 0;
      return out;
    }
    if (k >= lastI) {
      out.s = this.anchors[lastI] as number;
      out.v = 0;
      return out;
    }
    const i = Math.floor(k);
    const a = this.anchors[i] as number;
    const b = this.anchors[i + 1] as number;
    out.s = a + (b - a) * (k - i);
    out.v = (b - a) / stepSeconds;
    return out;
  }

  /** Reference arc length at a step boundary (clamped to the timeline). */
  anchorAt(step: number): number {
    const i = Math.min(Math.max(step - this.startStep, 0), this.anchors.length - 1);
    return this.anchors[i] as number;
  }

  /**
   * Latest time (seconds) at which the reference is at arc length `s`. During
   * a planned wait the reference sits still, so "behind schedule" is measured
   * from the end of the wait, not from its start.
   */
  timeAt(s: number, stepSeconds: number): number {
    for (let i = 0; i < this.anchors.length - 1; i++) {
      const a = this.anchors[i] as number;
      const b = this.anchors[i + 1] as number;
      // Same 1 µm tolerance as nextStop: a robot that far from a point is on it.
      if (s < a - 1e-6) return (this.startStep + i) * stepSeconds;
      if (s < b - 1e-6) return (this.startStep + i + Math.max(0, s - a) / (b - a)) * stepSeconds;
    }
    return this.endStep * stepSeconds;
  }

  /** First stop strictly ahead of `s`. */
  nextStop(s: number): number {
    for (const stop of this.stops) if (stop > s + 1e-6) return stop;
    return this.length;
  }

  pieceIndex(s: number): number {
    const p = this.pieces;
    if (p.length === 0) return -1;
    let lo = 0;
    let hi = p.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((p[mid] as Piece).s0 <= s + 1e-9) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Position and heading (radians from +x toward +z) at arc length `s`. */
  pose(
    s: number,
    out: { x: number; z: number; heading: number },
  ): { x: number; z: number; heading: number } {
    const idx = this.pieceIndex(s);
    if (idx < 0) {
      out.x = this.firstX;
      out.z = this.firstZ;
      return out;
    }
    const p = this.pieces[idx] as Piece;
    const u = Math.min(Math.max(s - p.s0, 0), p.len);
    if (!p.arc) {
      out.x = p.x0 + p.dx * u;
      out.z = p.z0 + p.dz * u;
      out.heading = Math.atan2(p.dz, p.dx);
    } else {
      const r = p.len / (Math.PI / 2);
      const ang = p.a0 + p.sweep * (u / p.len);
      out.x = p.cx + r * Math.cos(ang);
      out.z = p.cz + r * Math.sin(ang);
      out.heading = Math.atan2(
        Math.sign(p.sweep) * Math.cos(ang),
        -Math.sign(p.sweep) * Math.sin(ang),
      );
    }
    return out;
  }

  /** Heading the robot must have to start along the path at `s` (direction of the next piece). */
  headingAhead(s: number): number | null {
    const idx = this.pieceIndex(s + 1e-6);
    if (idx < 0) return null;
    const p = this.pieces[idx] as Piece;
    if (s >= p.s0 + p.len - 1e-9) return null; // at the end
    const pose = this.pose(Math.max(s, p.s0) + 1e-6, { x: 0, z: 0, heading: 0 });
    return pose.heading;
  }

  get firstX(): number {
    return this.pieces.length ? (this.pieces[0] as Piece).x0 : 0;
  }

  get firstZ(): number {
    return this.pieces.length ? (this.pieces[0] as Piece).z0 : 0;
  }

  /** Smallest speed limit from arcs at or ahead of `s` within `lookahead`, given braking. */
  arcLimit(
    s: number,
    lookahead: number,
    vTurn: number,
    v: number,
    decel: number,
    dt: number,
  ): number {
    let limit = Infinity;
    for (let i = Math.max(this.pieceIndex(s), 0); i < this.pieces.length; i++) {
      const p = this.pieces[i] as Piece;
      if (p.s0 > s + lookahead) break;
      if (!p.arc) continue;
      if (s >= p.s0 - 1e-9 && s <= p.s0 + p.len) limit = Math.min(limit, vTurn);
      else if (p.s0 > s) limit = Math.min(limit, brakeCap(v, p.s0 - s, vTurn, decel, dt));
    }
    return limit;
  }

  /** Reference arc length at time `t` when trailing it by `gap` seconds. */
  trailingAt(t: number, gap: number, stepSeconds: number): number {
    const k = (t - gap) / stepSeconds - this.startStep;
    const lastI = this.anchors.length - 1;
    if (k <= 0) return this.anchors[0] as number;
    if (k >= lastI) return this.anchors[lastI] as number;
    const i = Math.floor(k);
    const a = this.anchors[i] as number;
    return a + ((this.anchors[i + 1] as number) - a) * (k - i);
  }

  /**
   * True if a robot at (s1, v1) at time t1 that brakes at `decel` from now on
   * never gets ahead of the reference trailed by `gap`. The reference is
   * piecewise linear in time and the braking curve is a parabola, so each
   * piece is checked at its ends and where both speeds are equal.
   */
  brakingStaysBehind(
    t1: number,
    s1: number,
    v1: number,
    decel: number,
    gap: number,
    stepSeconds: number,
  ): boolean {
    const stopU = v1 / decel;
    const B = (u: number) =>
      u >= stopU ? s1 + (v1 * v1) / (2 * decel) : s1 + v1 * u - (decel * u * u) / 2;
    const ok = (u: number) => this.trailingAt(t1 + u, gap, stepSeconds) - B(u) >= -1e-9;
    if (!ok(0)) return false;
    // Boundaries of the reference pieces (shifted by the trailing gap) inside [t1, t1 + stopU].
    const firstBoundary = Math.ceil((t1 - gap) / stepSeconds);
    let prevU = 0;
    for (let b = firstBoundary; ; b++) {
      const u = Math.min(b * stepSeconds + gap - t1, stopU);
      if (u > prevU) {
        // Inside (prevU, u) the reference moves at a constant speed V.
        const mid = (prevU + u) / 2;
        const V =
          (this.trailingAt(t1 + mid + 1e-6, gap, stepSeconds) -
            this.trailingAt(t1 + mid - 1e-6, gap, stepSeconds)) /
          2e-6;
        const uStar = (v1 - V) / decel;
        if (uStar > prevU && uStar < u && !ok(uStar)) return false;
        if (!ok(u)) return false;
        prevU = u;
      }
      if (u >= stopU) return true;
    }
  }
}

/**
 * Highest speed for the next tick from which the robot can still reach speed
 * `vTarget` within distance `d`, braking at `decel` with trapezoidal
 * integration (s += (v + vNew)/2 · dt). Solves
 * vNew² − vTarget² ≤ 2·decel·(d − (v + vNew)/2 · dt) for vNew.
 */
export function brakeCap(v: number, d: number, vTarget: number, decel: number, dt: number): number {
  const b = decel * dt;
  const c = vTarget * vTarget + 2 * decel * d - decel * v * dt;
  const disc = b * b + 4 * c;
  if (disc <= 0) return 0;
  return Math.max(0, (-b + Math.sqrt(disc)) / 2);
}

/** Seconds the robot keeps behind its reference while cruising. */
export const FOLLOW_GAP = 0.05;

function angleDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

export class RobotMotion {
  x: number;
  z: number;
  heading: number;
  v = 0;
  s = 0;
  /** Meters traveled (battery use). */
  odometer = 0;
  /** Times braking had to exceed the normal deceleration (should stay 0). */
  brakingViolations = 0;
  timeline: PathTimeline | null = null;
  private readonly ref = { s: 0, v: 0 };
  private readonly pose = { x: 0, z: 0, heading: 0 };
  readonly vTurn: number;

  constructor(
    private readonly grid: FloorGrid,
    readonly params: MotionParams,
    cell: number,
    heading: number,
  ) {
    this.x = grid.x(cell);
    this.z = grid.z(cell);
    this.heading = heading;
    this.vTurn = Math.sqrt(params.lateralAccel * params.turnRadius);
  }

  /**
   * Replaces the path. `cells` starts at `startStep` and must contain the
   * robot's committed cells; `boundary` is the current step boundary, where
   * the old and new reference meet. The robot keeps its distance behind that
   * point, so the motion stays continuous.
   */
  setPlan(cells: readonly number[], startStep: number, boundary: number): void {
    const next = new PathTimeline(this.grid, cells, startStep, this.params.turnRadius);
    const behind = this.timeline ? Math.max(0, this.timeline.anchorAt(boundary) - this.s) : 0;
    this.timeline = next;
    this.s = Math.max(0, next.anchorAt(boundary) - behind);
    if (next.pieces.length > 0) {
      next.pose(this.s, this.pose);
      this.x = this.pose.x;
      this.z = this.pose.z;
    }
  }

  /**
   * Checkpoints. The path itself is not stored: it is always built from the
   * robot's timed cells (`Robot.cells` from `Robot.planStart`), so `load`
   * rebuilds it from them.
   */
  save(w: StateWriter): void {
    w.float(this.x);
    w.float(this.z);
    w.float(this.heading);
    w.float(this.v);
    w.float(this.s);
    w.float(this.odometer);
    w.int(this.brakingViolations);
    w.bool(this.timeline !== null);
  }

  load(r: StateReader, cells: readonly number[], startStep: number): void {
    this.x = r.float();
    this.z = r.float();
    this.heading = r.float();
    this.v = r.float();
    this.s = r.float();
    this.odometer = r.float();
    this.brakingViolations = r.int();
    this.timeline = r.bool()
      ? new PathTimeline(this.grid, cells, startStep, this.params.turnRadius)
      : null;
  }

  /** Puts the robot at rest on `cell` (scenario setup). */
  teleport(cell: number, heading: number): void {
    this.x = this.grid.x(cell);
    this.z = this.grid.z(cell);
    this.heading = heading;
    this.v = 0;
    this.s = 0;
    this.timeline = null;
  }

  /** Stops following any path (the robot stays where it is). */
  clearPlan(): void {
    this.timeline = null;
    this.v = 0;
  }

  /** Advances the robot by `dt` seconds; `t` is the simulation time at the end of the tick. */
  update(t: number, dt: number): void {
    const tl = this.timeline;
    const p = this.params;
    if (!tl || tl.pieces.length === 0) {
      this.v = 0;
      return;
    }
    tl.reference(t, p.stepSeconds, this.ref);
    // Stopped at a corner: rotate in place toward the next piece. This uses
    // the waiting time the planner reserved for it, before the reference leaves.
    if (this.v < 1e-3) {
      const want = tl.headingAhead(this.s);
      if (want !== null) {
        const diff = angleDiff(this.heading, want);
        if (Math.abs(diff) > 0.01) {
          const turn = Math.sign(diff) * Math.min(Math.abs(diff), p.turnRate * dt);
          this.heading += turn;
          this.v = 0;
          return;
        }
      }
    }
    // Speed for this tick: as fast as allowed, but never so fast that braking
    // at the normal deceleration could no longer keep the robot behind its
    // (slightly trailed) reference, and slow enough for upcoming turns.
    const stopAhead = tl.nextStop(this.s);
    const lookahead = (p.vMax * p.vMax) / (2 * p.decel) + 0.05;
    const lo = Math.max(0, this.v - p.decel * dt);
    let hi = Math.min(p.vMax, this.v + p.accel * dt);
    hi = Math.min(hi, brakeCap(this.v, stopAhead - this.s, 0, p.decel, dt));
    hi = Math.min(hi, tl.arcLimit(this.s, lookahead, this.vTurn, this.v, p.decel, dt));
    const safe = (v1: number) =>
      tl.brakingStaysBehind(
        t,
        this.s + ((this.v + v1) / 2) * dt,
        v1,
        p.decel,
        FOLLOW_GAP,
        p.stepSeconds,
      );
    let vNew: number;
    if (lo === 0 && !safe(0)) {
      // Slow enough to stop within this tick at the normal deceleration.
      vNew = 0;
    } else if (hi < lo - 1e-12 || !safe(lo)) {
      // The plan asked for more braking than allowed; brake harder and count it.
      this.brakingViolations++;
      vNew = Math.max(0, this.v - 2 * p.decel * dt);
    } else if (safe(hi)) {
      vNew = hi;
    } else {
      let a = lo;
      let b = hi;
      for (let i = 0; i < 16; i++) {
        const m = (a + b) / 2;
        if (safe(m)) a = m;
        else b = m;
      }
      vNew = a;
    }
    let sNew = this.s + ((this.v + vNew) / 2) * dt;
    // Settle exactly on a stop point instead of creeping toward it forever.
    if (stopAhead - sNew < 0.002 && this.v <= p.decel * dt + 1e-9) {
      sNew = Math.min(stopAhead, this.ref.s);
      if (sNew >= stopAhead) vNew = 0;
    }
    if (sNew >= this.ref.s) {
      // Never ahead of the plan: ride on the reference.
      sNew = Math.max(this.s, this.ref.s);
      vNew = Math.min(vNew, this.ref.v);
    }
    this.odometer += sNew - this.s;
    this.s = sNew;
    this.v = vNew;
    tl.pose(this.s, this.pose);
    this.x = this.pose.x;
    this.z = this.pose.z;
    if (this.v > 1e-3 || tl.headingAhead(this.s) === null) this.heading = this.pose.heading;
  }

  /** Seconds the robot is behind its reference (0 when on time). */
  lag(t: number): number {
    const tl = this.timeline;
    if (!tl) return 0;
    tl.reference(t, this.params.stepSeconds, this.ref);
    if (this.ref.s - this.s < 1e-6) return 0;
    return t - tl.timeAt(this.s, this.params.stepSeconds);
  }

  /** At rest at the end of the current path (or without a path). */
  get arrived(): boolean {
    const tl = this.timeline;
    if (!tl) return true;
    return this.v < 1e-3 && this.s >= tl.length - 1e-6;
  }
}
