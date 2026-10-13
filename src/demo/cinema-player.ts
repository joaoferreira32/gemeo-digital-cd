import { Vector3, type WebGLRenderer } from 'three';
import type { Bottleneck } from '../ai/bottleneck';
import { decodeFrame, type SimFrame } from '../link/frames';
import type { SimLink } from '../link/link';
import type { SceneView } from '../render/scene';
import { pointOnEdge, type EdgePoint } from '../sim/graph';
import { DEFAULT_DETECTOR } from '../sim/health';
import type { WarehouseLayout } from '../sim/layout';
import { SplitRouter } from '../sim/routing';
import {
  CONVEYOR,
  CONVEYOR_STRIDE,
  HEADER,
  JOBS,
  PACKET_STRIDE,
  ROBOT,
  ROBOT_STRIDE,
} from '../sim/snapshot';
import type { SimMessage } from '../worker/protocol';
import {
  CINEMA_FPS,
  bottleneckText,
  cinemaCardRows,
  formatFrames,
  itemsAt,
  lookAt,
  momentAt,
  panesOf,
  shortLabel,
  type Anchor,
  type CinemaFormat,
  type Look,
  type Moment,
  type Pane,
  type Segment,
} from './cinema';
import { drawCinema, type OverlayScene } from './cinema-overlay';
import { CinemaRecording } from './cinema-record';
import type { CinemaSide } from './cinema-run';
import { DEMO_EXPLICADA, type DemoSide } from './run';

/**
 * Plays the cinema demo on the page (src/demo/cinema.ts says what to show):
 * frame by frame, each frame asks both simulations (one worker per side,
 * src/demo/cinema-run.ts) for its exact moment, moves each pane's camera,
 * sets the look of the segment, draws both scenes on the one renderer (one
 * above the other, or side by side) and the words over them, on a 2D canvas
 * the size of the video. Live, frames wait for their time on the clock (a
 * slow machine plays slower, never different); recording, each frame goes
 * into the MP4 as soon as it is drawn, 60 per second of video exactly.
 */

export type CinemaMode = 'live' | 'record' | 'fast';

/** What the page lends the player. */
export interface CinemaStage {
  readonly renderer: WebGLRenderer;
  /** The WebGL canvas (drawn into the screen canvas every frame). */
  readonly scene: HTMLCanvasElement;
  /** The 2D canvas shown while the cinema plays, the size of the video. */
  readonly screen: HTMLCanvasElement;
  readonly layout: WarehouseLayout;
  /** A new view of the warehouse on the shared renderer. */
  view(): SceneView;
  /** A new simulation (a worker). */
  link(): SimLink;
  /** A line in the demo bar. */
  note(text: string): void;
}

interface Side {
  readonly side: CinemaSide;
  readonly link: SimLink;
  readonly view: SceneView;
  frame: SimFrame | null;
  bottleneck: Bottleneck | null;
  queue: number;
  measure: DemoSide | null;
  /** The answer awaited for a frame. */
  waiting: { frame: number; resolve: () => void; reject: (e: Error) => void } | null;
  /** The last moment asked for (s). */
  asked: number;
  /** The view's size and look now (set when they change). */
  size: string;
  heat: Look['heat'] | null;
  racks: number;
}

/** Seconds of the motor's readings the forecast shows. */
const HISTORY = 40;
/** The belt that breaks in the script, and the one whose motor wears. */
const BROKEN = DEMO_EXPLICADA.failure.target;
const WORN = DEMO_EXPLICADA.wear.target;

export class CinemaPlayer {
  /** The frame drawn last (−1 before the first). */
  frame = -1;
  /**
   * Live: the stalls (two frames more than 1.5 refreshes apart), the longest
   * gap between two frames (ms), and the real seconds the whole play took
   * from the first frame on screen (automated checks).
   */
  readonly pace = { stalls: 0, worstMs: 0, seconds: 0 };
  readonly frames: number;
  private readonly sides: Record<CinemaSide, Side>;
  private readonly ctx: CanvasRenderingContext2D;
  private stopped = false;
  private segmentIndex = -1;
  private time = NaN;
  private readonly point3 = new Vector3();
  private readonly edgePoint: EdgePoint = { x: 0, z: 0, heading: 0 };
  /** The worn motor's readings, one per simulated second (the AI side). */
  private readonly history = {
    second: -1,
    vibration: [] as number[],
    temperature: [] as number[],
    sum: [] as number[],
  };
  /** Frames to hand to whoever waits for them (captures), by frame number. */
  private readonly shots = new Map<number, (png: string) => void>();
  private recording: CinemaRecording | null = null;
  /** The routing choice whose static way is the broken belt (its share: the detour). */
  private readonly detour: number;
  /** The MP4, once a recording has ended. */
  video: Blob | null = null;

  constructor(
    private readonly stage: CinemaStage,
    readonly format: CinemaFormat,
    readonly mode: CinemaMode,
  ) {
    this.frames = formatFrames(format);
    this.detour = new SplitRouter(stage.layout.graph, stage.layout.dockNodes).decisions.findIndex(
      (d) => d.primary === BROKEN,
    );
    const make = (side: CinemaSide): Side => {
      const link = stage.link();
      const view = stage.view();
      view.useCinemaLook();
      view.orbit.locked = true;
      const s: Side = {
        side,
        link,
        view,
        frame: null,
        bottleneck: null,
        queue: 0,
        measure: null,
        waiting: null,
        asked: NaN,
        size: '',
        heat: null,
        racks: -1,
      };
      link.onMessage = (msg) => this.onMessage(s, msg);
      link.send({ type: 'cinema', action: 'start', side });
      return s;
    };
    this.sides = { 'no-ai': make('no-ai'), ai: make('ai') };
    const { width, height } = format;
    stage.renderer.setPixelRatio(1);
    stage.renderer.setSize(width, height, false);
    stage.screen.width = width;
    stage.screen.height = height;
    this.ctx = stage.screen.getContext('2d', { alpha: false }) as CanvasRenderingContext2D;
  }

  /** Plays to the end (or until stopped). The recording's file is in `video` after it. */
  async play(): Promise<void> {
    if (this.mode === 'record') {
      const rec = await CinemaRecording.open(this.stage.screen, CINEMA_FPS);
      if (typeof rec === 'string') throw new Error(rec);
      this.recording = rec;
    }
    let started = performance.now();
    let last = started;
    for (let k = 0; k < this.frames && !this.stopped; k++) {
      if (this.mode === 'live' && k > 0) {
        // A frame waits for its time on the clock (a millisecond early is on time: the
        // display's refresh); one drawn late is not skipped, the video plays on from it.
        const due = started + (k / CINEMA_FPS) * 1000;
        await nextFrame();
        while (!this.stopped && performance.now() < due - 1) await nextFrame();
      }
      await this.draw(k);
      if (this.mode === 'live') {
        // The clock starts with the first frame on screen (the simulations warm up before it).
        const now = performance.now();
        if (k === 0) started = now;
        else {
          const gap = now - last;
          if (gap > 1.5 * (1000 / CINEMA_FPS)) this.pace.stalls++;
          this.pace.worstMs = Math.max(this.pace.worstMs, gap);
        }
        last = now;
      }
      if (this.recording) {
        await this.recording.add(k);
        if (k % 30 === 0) {
          const pct = Math.round((k / this.frames) * 100);
          this.stage.note(
            `Gravando: quadro ${(k + 1).toLocaleString('pt-BR')} de ${this.frames.toLocaleString('pt-BR')} (${pct}%).`,
          );
        }
      } else if (this.mode === 'fast' && k % 4 === 0) {
        // Lets the page breathe (and a capture script talk to it).
        await nextFrame();
      }
    }
    this.pace.seconds = (performance.now() - started) / 1000;
    if (this.recording && !this.stopped) this.video = await this.recording.finish();
  }

  /** Hands frame `k` (a PNG data URL) once it is drawn: captures of the real thing. */
  shot(k: number): Promise<string> {
    return new Promise((resolve) => this.shots.set(k, resolve));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.recording?.cancel();
    for (const s of Object.values(this.sides)) {
      s.waiting?.reject(new Error('stopped'));
      s.waiting = null;
      s.link.send({ type: 'cinema', action: 'stop' });
      s.link.dispose();
      s.view.dispose();
    }
  }

  // ---------------------------------------------------------------- one frame

  private async draw(k: number): Promise<void> {
    const m = momentAt(this.format, k);
    const segment = m.segment;
    const cut = m.index !== this.segmentIndex;
    const wantsCard = segment.items.some((i) => i.kind === 'card');
    // Both runs move together (the one not on screen too: it appears in step).
    await Promise.all(Object.values(this.sides).map((s) => this.ask(s, k, m.time, wantsCard)));
    if (this.stopped) return;
    const simDt = Number.isNaN(this.time) ? 0 : Math.max(0, m.time - this.time);
    if (m.time < this.time) this.clearHistory();
    this.time = m.time;
    this.sample();

    const panes = panesOf(this.format, segment.layout);
    const look = lookAt(segment, m.local);
    if (cut && segment.shot.target.kind === 'robot') {
      this.followRackRobot();
    }
    for (const s of Object.values(this.sides)) {
      const pane = panes.find((p) => p.side === s.side) ?? panes[0]!;
      this.prepare(s, pane, segment, m, look, cut);
      if (s.frame) s.view.update(1 / CINEMA_FPS, s.frame, 1, simDt);
      this.focus(s, segment);
    }
    this.segmentIndex = m.index;

    const r = this.stage.renderer;
    const { width, height } = this.format;
    for (const pane of panes) {
      this.sides[pane.side].view.renderPane(pane.x, pane.y, pane.w, pane.h, height);
    }
    r.setViewport(0, 0, width, height);
    const ctx = this.ctx;
    ctx.drawImage(this.stage.scene, 0, 0, width, height);
    drawCinema(ctx, this.overlay(m, panes));
    this.frame = k;
    const shot = this.shots.get(k);
    if (shot) {
      this.shots.delete(k);
      shot(this.stage.screen.toDataURL('image/png'));
    }
  }

  private ask(s: Side, k: number, time: number, measure: boolean): Promise<void> {
    if (time === s.asked && !measure && s.frame) return Promise.resolve();
    s.asked = time;
    return new Promise((resolve, reject) => {
      s.waiting = { frame: k, resolve, reject };
      s.link.send({ type: 'cinema', action: 'to', time, frame: k, measure });
    });
  }

  private onMessage(s: Side, msg: SimMessage): void {
    if (msg.type === 'error') {
      s.waiting?.reject(new Error(msg.message));
      s.waiting = null;
      return;
    }
    if (msg.type !== 'cinema') return;
    const old = s.frame;
    s.frame = decodeFrame(msg.buffer, msg.events);
    if (old) s.link.send({ type: 'release', buffer: old.buffer }, [old.buffer]);
    s.bottleneck = msg.bottleneck;
    s.queue = msg.queue;
    if (msg.measure) s.measure = msg.measure;
    if (s.waiting && s.waiting.frame === msg.frame) {
      const done = s.waiting.resolve;
      s.waiting = null;
      done();
    }
  }

  /** The pane's size, the camera of the shot, the look of the segment. */
  private prepare(
    s: Side,
    pane: Pane,
    segment: Segment,
    m: Moment,
    look: Look,
    cut: boolean,
  ): void {
    const view = s.view;
    const size = `${pane.w}×${pane.h}`;
    if (size !== s.size) {
      view.applyQuality('alta', pane.w, pane.h, 1, false);
      s.size = size;
    }
    const shot = segment.shot;
    const target = this.world(shot.target, s);
    if (target) {
      const turn = shot.turn * (m.local / Math.max(segment.seconds, 1e-6));
      view.orbit.aim(target, shot.radius, shot.phi, shot.theta + turn, shot.glide);
      if (cut && !shot.glide) view.orbit.snap();
    }
    if (look.heat !== s.heat) {
      view.setHeatLayer(look.heat);
      s.heat = look.heat;
    }
    if (look.racks !== s.racks) {
      view.setRackBrightness(look.racks);
      s.racks = look.racks;
    }
    // The AI's marks only where the AI is: its arrows and its finding.
    const ai = s.side === 'ai';
    view.flows.mesh.visible = ai && look.arrows > 0;
    view.flows.emphasis = Math.max(1, look.arrows);
    view.setBottleneck(ai && look.ring && s.bottleneck ? s.bottleneck : null);
    view.pastLook = look.past;
  }

  /**
   * The robot the camera follows: the first one working at the racks ("40
   * robôs buscam pacotes nas prateleiras"), else the first with a rack job, else any working one.
   */
  private followRackRobot(): void {
    const s = this.sides.ai;
    const frame = s.frame;
    if (!frame) return;
    const n = frame.s.header[HEADER.robots] as number;
    const racks = this.stage.layout.racks;
    const minX = Math.min(...racks.map((r) => r.x0));
    const maxX = Math.max(...racks.map((r) => r.x1));
    const minZ = Math.min(...racks.map((r) => Math.abs(r.z)));
    const maxZ = Math.max(...racks.map((r) => Math.abs(r.z)));
    let first = -1;
    for (let r = 0; r < n; r++) {
      const o = r * ROBOT_STRIDE;
      if (frame.s.robots[o + ROBOT.job] !== JOBS.indexOf('rack')) continue;
      if (first < 0) first = r;
      // Already among the racks: the shot shows the shelves it works at.
      const x = frame.s.robots[o + ROBOT.x1] as number;
      const z = Math.abs(frame.s.robots[o + ROBOT.z1] as number);
      if (x >= minX && x <= maxX && z >= minZ - 0.5 && z <= maxZ + 0.5) {
        s.view.followRobot = r;
        return;
      }
    }
    if (first >= 0) s.view.followRobot = first;
    else s.view.nextFollow(frame, false);
  }

  /** Depth of field on the shot's point (after the camera moved). */
  private focus(s: Side, segment: Segment): void {
    const f = segment.shot.focus;
    const at = f ? this.world(f.at, s) : null;
    if (!f || !at) {
      s.view.setFocus(null);
      return;
    }
    const d = s.view.orbit.camera.position.distanceTo(at);
    s.view.setFocus(d, { aperture: f.aperture, maxblur: f.maxblur });
  }

  /** One reading of the worn motor per simulated second (the forecast's charts). */
  private sample(): void {
    const frame = this.sides.ai.frame;
    if (!frame) return;
    const second = Math.floor(this.time + 1e-9);
    const h = this.history;
    if (second <= h.second) return;
    h.second = second;
    const o = WORN * CONVEYOR_STRIDE;
    const c = frame.s.conveyors;
    h.vibration.push(c[o + CONVEYOR.vibration] as number);
    h.temperature.push(c[o + CONVEYOR.temperature] as number);
    h.sum.push((c[o + CONVEYOR.risk] as number) * DEFAULT_DETECTOR.threshold);
    for (const a of [h.vibration, h.temperature, h.sum]) if (a.length > HISTORY + 1) a.shift();
  }

  private clearHistory(): void {
    const h = this.history;
    h.second = -1;
    h.vibration.length = h.temperature.length = h.sum.length = 0;
  }

  // ---------------------------------------------------------------- the overlay's inputs

  private overlay(m: Moment, panes: Pane[]): OverlayScene {
    const segment = m.segment;
    const ai = this.sides.ai;
    const b = ai.bottleneck;
    const timeline = segment.items.find((i) => i.kind === 'timeline');
    const card = segment.items.find((i) => i.kind === 'card');
    let at = m.time;
    if (timeline && timeline.kind === 'timeline') {
      const p = Math.min(1, Math.max(0, (m.local - timeline.from) / (timeline.to - timeline.from)));
      const ease = p * p * (3 - 2 * p);
      at = timeline.sim[0] + (timeline.sim[1] - timeline.sim[0]) * ease;
    }
    const share = ai.frame ? this.detourShare(ai.frame) : 0;
    return {
      width: this.format.width,
      height: this.format.height,
      split: this.format.split,
      layout: segment.layout,
      panes,
      items: itemsAt(segment, m.local),
      speed: m.speed,
      point: (anchor, side) => this.screen(anchor, side, panes),
      routes: () => this.routes(panes),
      queue: { ai: ai.queue, 'no-ai': this.sides['no-ai'].queue },
      share,
      bottleneck:
        b && b.kind === 'conveyor' ? { text: bottleneckText(b), label: shortLabel(b.label) } : null,
      forecast:
        this.history.sum.length > 1
          ? {
              vibration: this.history.vibration,
              temperature: this.history.temperature,
              sum: this.history.sum,
              limit: DEFAULT_DETECTOR.threshold,
            }
          : null,
      card:
        card && card.kind === 'card' && ai.measure && this.sides['no-ai'].measure
          ? cinemaCardRows(card.rows, ai.measure, this.sides['no-ai'].measure)
          : null,
      timeline: {
        at,
        from: timeline?.kind === 'timeline' ? timeline.sim[0] : 0,
        to: timeline?.kind === 'timeline' ? timeline.sim[1] : 0,
        breakAt: DEMO_EXPLICADA.failure.at,
      },
    };
  }

  /** Share of the packets at the junction before the broken belt going around it (B2 by line A). */
  private detourShare(frame: SimFrame): number {
    return this.detour >= 0 ? ((frame.s.shares[this.detour] as number | undefined) ?? 0) : 0;
  }

  /** A point of the scene, in the world (null when it cannot be had now). */
  private world(anchor: Anchor, s: Side): Vector3 | null {
    const v = new Vector3();
    const layout = this.stage.layout;
    switch (anchor.kind) {
      case 'point':
        return v.set(anchor.x, anchor.y, anchor.z);
      case 'belt': {
        const e = layout.graph.edge(anchor.id);
        pointOnEdge(e, e.length * anchor.at, this.edgePoint);
        return v.set(this.edgePoint.x, anchor.y, this.edgePoint.z);
      }
      case 'node': {
        const n = layout.graph.nodes.find((x) => x.name === anchor.name);
        return n ? v.set(n.pos.x, anchor.y, n.pos.z) : null;
      }
      case 'motor': {
        const spot = s.view.motors.spots[anchor.id];
        return spot ? v.set(spot.x + (anchor.dx ?? 0), anchor.y, spot.z + (anchor.dz ?? 0)) : null;
      }
      case 'center': {
        const b = layout.bounds;
        return v.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
      }
      case 'robot': {
        const p = s.view.poses;
        if (p.count === 0) return null;
        const r = Math.min(s.view.followRobot, p.count - 1);
        return v.set(p.x[r] as number, 0.3, p.z[r] as number);
      }
      case 'bottleneck': {
        const b = this.sides.ai.bottleneck;
        if (!b || b.kind !== 'conveyor') return null;
        const e = layout.graph.edge(b.index);
        pointOnEdge(e, e.length / 2, this.edgePoint);
        return v.set(this.edgePoint.x, 0.2, this.edgePoint.z);
      }
      case 'queue-head':
      case 'route':
        return null;
    }
  }

  /** A point on screen in a side's pane: through its camera, or picked among what is in sight. */
  private screen(
    anchor: Anchor,
    side: CinemaSide,
    panes: Pane[],
  ): readonly [number, number] | null {
    const s = this.sides[side];
    const pane = panes.find((p) => p.side === side) ?? panes[0]!;
    if (anchor.kind === 'queue-head') return this.queueHead(s, pane);
    if (anchor.kind === 'route') return this.routeRobot(pane);
    const w = this.world(anchor, s);
    return w ? this.project(s, pane, w.x, w.y, w.z) : null;
  }

  private project(s: Side, pane: Pane, x: number, y: number, z: number): [number, number] | null {
    const v = this.point3.set(x, y, z).project(s.view.orbit.camera);
    if (v.z > 1 || v.z < -1) return null;
    return [pane.x + ((v.x + 1) / 2) * pane.w, pane.y + ((1 - v.y) / 2) * pane.h];
  }

  /**
   * The first stopped packet of the broken belt's queue that is in sight
   * (the queue's head as the shot frames it: the belt and the one before it).
   */
  private queueHead(s: Side, pane: Pane): [number, number] | null {
    const frame = s.frame;
    if (!frame) return null;
    const graph = this.stage.layout.graph;
    const lines = [graph.edge(BROKEN - 1), graph.edge(BROKEN)].map(
      (e) => [e.points[0]!, e.points.at(-1)!] as const,
    );
    const near = (x: number, z: number) =>
      lines.some(([a, b]) => {
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
        return Math.hypot(a.x + dx * t - x, a.z + dz * t - z) < 0.8;
      });
    const p = frame.s.packets;
    const n = frame.s.header[HEADER.packets] as number;
    let best: [number, number] | null = null;
    let bestX = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * PACKET_STRIDE;
      const x = p[o + 3] as number;
      const z = p[o + 4] as number;
      if ((p[o + 6] as number) < 0.5 || !near(x, z) || x <= bestX) continue;
      const at = this.project(s, pane, x, 1.05, z);
      if (!at) continue;
      const inside =
        at[0] > pane.x + 80 &&
        at[0] < pane.x + pane.w - 80 &&
        at[1] > pane.y + 320 &&
        at[1] < pane.y + pane.h - 170;
      if (!inside) continue;
      best = at;
      bestX = x;
    }
    return best;
  }

  /** A robot in sight with a long reserved route (where the X-ray's label points). */
  private routeRobot(pane: Pane): [number, number] | null {
    const s = this.sides.ai;
    const frame = s.frame;
    if (!frame) return null;
    const poses = s.view.poses;
    let best: [number, number] | null = null;
    let longest = 3;
    for (let r = 0; r < poses.count; r++) {
      const len = frame.s.robots[r * ROBOT_STRIDE + ROBOT.routeLength] as number;
      if (len <= longest) continue;
      const at = this.project(s, pane, poses.x[r] as number, 0.4, poses.z[r] as number);
      if (!at) continue;
      const u = (at[0] - pane.x) / pane.w;
      const v = (at[1] - pane.y) / pane.h;
      if (u < 0.18 || u > 0.83 || v < 0.28 || v > 0.64) continue;
      best = at;
      longest = len;
    }
    return best;
  }

  /** Every robot's reserved route on screen (the X-ray). */
  private routes(panes: Pane[]): [number, number][][] {
    const s = this.sides.ai;
    const frame = s.frame;
    if (!frame) return [];
    const pane = panes.find((p) => p.side === 'ai') ?? panes[0]!;
    const poses = s.view.poses;
    const out: [number, number][][] = [];
    for (let r = 0; r < poses.count; r++) {
      const o = r * ROBOT_STRIDE;
      const off = frame.s.robots[o + ROBOT.routeOffset] as number;
      const len = Math.min(frame.s.robots[o + ROBOT.routeLength] as number, 32);
      if (len < 4) continue;
      const pts: [number, number][] = [];
      const start = this.project(s, pane, poses.x[r] as number, 0.06, poses.z[r] as number);
      if (start) pts.push(start);
      for (let k = 1; k < len; k++) {
        const at = this.project(
          s,
          pane,
          frame.s.routes[(off + k) * 2] as number,
          0.06,
          frame.s.routes[(off + k) * 2 + 1] as number,
        );
        if (at) pts.push(at);
      }
      if (pts.length > 1) out.push(pts);
    }
    return out;
  }
}

/** The next animation frame (or a short wait where there is none). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}
