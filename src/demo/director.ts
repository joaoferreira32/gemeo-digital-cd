import { Vector3 } from 'three';
import type { Bottleneck } from '../ai/bottleneck';
import type { SimEvent } from '../sim/failures';
import { pointOnEdge, type EdgePoint } from '../sim/graph';
import type { WarehouseLayout } from '../sim/layout';
import type { SimCommand, SimMessage } from '../worker/protocol';
import { beatAt, wallSeconds, type Beat } from './beats';
import { cardRows } from './card';
import { DEMO_KINDS, type DemoKind } from './kinds';
import type { OverlayState } from './overlay';
import type { DemoKindId, DemoResult, DemoScript } from './run';

/**
 * The demo's director (phase 6), on the page: it follows the simulated time
 * being drawn and, beat by beat (src/demo/beats.ts, src/demo/explicada.ts),
 * sets the speed, holds the simulation still for a pause, moves the camera,
 * the depth of field, the heat map and the flow arrows, and says what to
 * draw over the scene; it takes the run back in time when the run with AI has
 * ended, and shows the final card when the run without AI has too. It
 * decides nothing about the simulation: the worker plays the script at fixed
 * ticks (src/demo/run.ts), so a slow machine only makes the demo slower,
 * never different.
 */

/** What the director moves on the page (main.ts gives it the scene). */
export interface DirectorStage {
  /** The camera glides to look at `target` from `radius` meters (`rate`: how fast it settles). */
  aim(target: Vector3, radius: number, phi: number, theta: number, rate?: number): void;
  /** A light depth of field on the camera's target, or none. */
  focus(on: boolean): void;
  heat(layer: 'off' | 'espera'): void;
  /** Where a working robot is (a new one when `pick`), or null without robots. */
  robot(pick: boolean): { readonly x: number; readonly z: number } | null;
  /** Where a belt's drive motor is. */
  motor?(belt: number): { readonly x: number; readonly z: number } | null;
  /** The flow arrows of the routing choices highlighted, or as usual. */
  arrows?(on: boolean): void;
  /** Packets queuing in the frame being drawn. */
  queue?(): number;
  send(cmd: SimCommand): void;
}

export type DirectorPhase = 'off' | 'preparing' | 'ai' | 'rewind' | 'no-ai' | 'card';

/** Seconds a caption, and the card, take to fade in; the veil of a cut, to fade out. */
const FADE = 0.4;
const VEIL = 0.5;
/** How fast the camera settles on a new shot in the explained demo (the app's is 7). */
const GLIDE = 2.5;

/** The caption of a beat with its live parts: the detector's words, the last event. */
export function captionText(beat: Beat, bottleneck: string, event: string): string {
  return beat.text
    .replace('{gargalo}', bottleneck || 'o detector lê a gravação segundo a segundo')
    .replace('{evento}', event || beat.idle || '')
    .trim();
}

/** "2,5×" for a speed above or below real time; nothing at 1×. */
export function speedBadge(speed: number): string {
  if (!(speed > 0) || speed === 1) return '';
  return `${speed.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}×`;
}

const ease = (t: number) => t * t * (3 - 2 * t);

export class Director {
  phase: DirectorPhase = 'off';
  private kind: DemoKind = DEMO_KINDS.explicada;
  private beat: Beat | null = null;
  /** Real seconds since the beat began, and since the demo began. */
  private beatWall = 0;
  private elapsed = 0;
  /** Real seconds since the card came up (the card and what follows it). */
  private cardWall = 0;
  /** Real seconds the simulation still holds still (a pause of the beat). */
  private holdLeft = 0;
  private compared = false;
  private result: DemoResult | null = null;
  private bottleneck = '';
  private event = '';
  private captionAlpha = 0;
  private cardAlpha = 0;
  private veil = 0;
  /** The queue, one sample per simulated second, since the first beat with the counter. */
  private queueHistory: number[] = [];
  private queueSecond = -1;
  private total = 0;
  private readonly target = new Vector3();
  private readonly point: EdgePoint = { x: 0, z: 0, heading: 0 };

  constructor(
    private readonly stage: DirectorStage,
    private readonly layout: WarehouseLayout,
    private readonly reducedMotion: () => boolean,
  ) {}

  get active(): boolean {
    return this.phase !== 'off';
  }

  get script(): DemoScript {
    return this.kind.script;
  }

  get beats(): readonly Beat[] {
    return this.kind.beats;
  }

  get demo(): DemoKind {
    return this.kind;
  }

  /** Real seconds the final card has been up (0 before it). */
  get cardSeconds(): number {
    return this.phase === 'card' ? this.cardWall : 0;
  }

  /** True once the card and what follows it have had their time (a recording ends here). */
  get finished(): boolean {
    if (this.phase !== 'card' || !this.result) return false;
    const after = this.kind.beats.filter((b) => b.side === 'card' || b.side === 'end');
    return this.cardWall >= after.reduce((t, b) => t + b.hold, 0);
  }

  /** The beat being shown, if any. */
  get current(): Beat | null {
    return this.beat;
  }

  /** True while a pause holds the simulation still. */
  get pausing(): boolean {
    return this.holdLeft > 0;
  }

  start(kind: DemoKindId = 'explicada'): void {
    this.kind = DEMO_KINDS[kind];
    this.total = wallSeconds(this.kind.beats);
    this.phase = 'preparing';
    this.beat = null;
    this.beatWall = 0;
    this.elapsed = 0;
    this.cardWall = 0;
    this.holdLeft = 0;
    this.compared = false;
    this.result = null;
    this.bottleneck = '';
    this.event = '';
    this.captionAlpha = 0;
    this.cardAlpha = 0;
    this.veil = 0;
    this.queueHistory = [];
    this.queueSecond = -1;
    this.stage.send({ type: 'demo', action: 'start', script: kind });
  }

  /** Leaves the demo (the page goes back to the ordinary app). */
  stop(): void {
    if (this.phase === 'off') return;
    this.phase = 'off';
    this.beat = null;
    this.holdLeft = 0;
    this.stage.focus(false);
    this.stage.arrows?.(false);
    this.stage.send({ type: 'demo', action: 'stop' });
  }

  /** Where the worker's run of the script is. */
  onDemo(msg: Extract<SimMessage, { type: 'demo' }>): void {
    if (this.phase === 'off') return;
    if (msg.phase === 'ai' && this.phase === 'preparing') {
      this.phase = 'ai';
    } else if (msg.phase === 'ai-done' && this.phase === 'ai') {
      // Back to a second before the breakdown: the page shows the past (the rewind look).
      this.phase = 'rewind';
      this.holdLeft = 0;
      this.stage.send({ type: 'seek', time: this.script.branchAt });
    } else if (msg.phase === 'no-ai' && this.phase === 'rewind') {
      this.phase = 'no-ai';
    } else if (msg.phase === 'done' && this.phase === 'no-ai') {
      this.result = msg.result;
      this.phase = 'card';
      this.cardWall = 0;
      this.holdLeft = 0;
      this.stage.send({ type: 'speed', speed: 0 });
    }
  }

  /** The detector's finding at the moment shown (status messages). */
  onBottleneck(b: Bottleneck | null): void {
    if (b) this.bottleneck = b.text;
  }

  /** New events of the run: the caption of the beat follows the kinds it names. */
  onEvents(events: readonly SimEvent[]): void {
    const kinds = this.beat?.events;
    if (!kinds) return;
    for (const e of events) if (kinds.includes(e.kind)) this.event = e.text;
  }

  /**
   * Once per frame, before the scene updates, with the simulated time being
   * drawn: moves the camera and returns what to draw over the scene.
   */
  frame(realDt: number, simTime: number): OverlayState | null {
    if (this.phase === 'off') return null;
    const explained = this.kind.explained;
    if (this.phase === 'preparing') {
      return { ...EMPTY, large: explained, status: 'Preparando a demo…' };
    }
    this.elapsed += realDt;
    if (this.phase === 'card') this.cardWall += realDt;
    const beat = this.beatFor(simTime);
    if (beat !== this.beat) this.enter(beat);
    this.beatWall += realDt;
    if (this.holdLeft > 0) {
      this.holdLeft -= realDt;
      if (this.holdLeft <= 0) {
        this.holdLeft = 0;
        this.stage.send({ type: 'speed', speed: beat.speed });
      }
    }
    if (this.phase === 'rewind' && !this.compared && this.beatWall >= beat.hold) {
      this.compared = true;
      this.stage.send({ type: 'demo', action: 'compare' });
    }
    this.sampleQueue(beat, simTime);
    this.shoot(beat, simTime);
    const still = this.reducedMotion();
    this.captionAlpha = still ? 1 : Math.min(1, this.captionAlpha + realDt / FADE);
    this.veil = Math.max(0, this.veil - realDt / VEIL);
    const card = this.phase === 'card' && this.result;
    const end = card && beat.side === 'end';
    this.cardAlpha = card && !end ? (still ? 1 : Math.min(1, this.cardAlpha + realDt / FADE)) : 0;
    const step =
      explained && beat.chapter
        ? {
            index: beat.chapter,
            count: this.kind.chapters.length,
            name: this.kind.chapters[beat.chapter - 1] ?? '',
          }
        : null;
    const sim = this.phase === 'ai' || this.phase === 'no-ai';
    return {
      title: card ? '' : beat.title,
      text: card ? '' : captionText(beat, this.bottleneck, this.event),
      alpha: this.captionAlpha,
      progress: Math.min(1, this.elapsed / Math.max(this.total, 1e-6)),
      card:
        card && !end
          ? {
              title: this.kind.card.title,
              subtitle: this.kind.card.subtitle,
              rows: cardRows(card, this.kind.card.avoided),
              notes: this.kind.card.notes,
            }
          : null,
      cardAlpha: this.cardAlpha,
      status: '',
      large: explained,
      step,
      badge: explained && sim ? (this.holdLeft > 0 ? 'pausado' : speedBadge(beat.speed)) : '',
      alert: sim ? (beat.alert ?? '') : '',
      counter:
        explained && sim && beat.counter
          ? { value: this.stage.queue?.() ?? 0, history: this.queueHistory }
          : null,
      bottleneck: beat.bottleneck ? this.bottleneck : '',
      timeline:
        explained && this.phase === 'rewind'
          ? {
              from: this.script.end,
              to: this.script.branchAt,
              at:
                this.script.end -
                (this.script.end - this.script.branchAt) *
                  ease(Math.min(1, this.beatWall / Math.max(beat.hold, 1e-6))),
            }
          : null,
      end: end ? beat.text : '',
      veil: this.veil,
    };
  }

  private beatFor(simTime: number): Beat {
    const beats = this.kind.beats;
    switch (this.phase) {
      case 'rewind':
        return beats.find((b) => b.side === 'rewind') as Beat;
      case 'card': {
        // The card, then what follows it, by the time each is held.
        let t = this.cardWall;
        const after = beats.filter((b) => b.side === 'card' || b.side === 'end');
        for (const b of after) {
          if (t < b.hold) return b;
          t -= b.hold;
        }
        return after.at(-1) as Beat;
      }
      case 'no-ai':
        return beatAt(beats, 'no-ai', simTime);
      default:
        return beatAt(beats, 'ai', simTime);
    }
  }

  private enter(beat: Beat): void {
    const before = this.beat;
    this.beat = beat;
    this.beatWall = 0;
    this.event = '';
    const sameWords = before && before.title === beat.title && before.text === beat.text;
    if (!sameWords) this.captionAlpha = this.reducedMotion() ? 1 : 0;
    // With reduced motion the camera cuts: a short fade hides it in the explained demo.
    if (this.kind.explained && this.reducedMotion() && before) this.veil = 1;
    if (beat.pause && beat.pause > 0 && (beat.side === 'ai' || beat.side === 'no-ai')) {
      this.holdLeft = beat.pause;
      this.stage.send({ type: 'speed', speed: 0 });
    } else if (beat.speed > 0) {
      this.stage.send({ type: 'speed', speed: beat.speed });
    }
    this.stage.heat(beat.heat);
    this.stage.arrows?.(beat.arrows === true);
    if (beat.shot.target.kind === 'robot') this.stage.robot(true);
  }

  /** One sample of the queue per simulated second, from the first beat with the counter on. */
  private sampleQueue(beat: Beat, simTime: number): void {
    if (!this.kind.explained || beat.side !== 'ai') return;
    if (!beat.counter && this.queueHistory.length === 0) return;
    const second = Math.floor(simTime);
    if (second === this.queueSecond) return;
    this.queueSecond = second;
    this.queueHistory.push(this.stage.queue?.() ?? 0);
  }

  /** The camera of the beat: its target, a slow turn as the beat goes on, the depth of field. */
  private shoot(beat: Beat, simTime: number): void {
    const shot = beat.shot;
    const span = beat.to - beat.from;
    const progress =
      beat.speed > 0 && span > 0
        ? Math.min(1, Math.max(0, (simTime - beat.from) / span))
        : Math.min(1, this.beatWall / Math.max(beat.hold, 1e-6));
    const still = this.reducedMotion();
    const t = shot.target;
    if (t.kind === 'belt') {
      const edge = this.layout.graph.edge(t.id);
      pointOnEdge(edge, edge.length / 2, this.point);
      this.target.set(this.point.x, 0.5, this.point.z);
    } else if (t.kind === 'node') {
      const node = this.layout.graph.nodes.find((n) => n.name === t.name);
      this.target.set(node?.pos.x ?? 0, 0.5, node?.pos.z ?? 0);
    } else if (t.kind === 'robot') {
      const r = this.stage.robot(false);
      if (r) this.target.set(r.x, 0.3, r.z);
    } else if (t.kind === 'motor') {
      const m = this.stage.motor?.(t.id);
      if (m) {
        this.target.set(m.x, 0.8, m.z);
      } else {
        const edge = this.layout.graph.edge(t.id);
        pointOnEdge(edge, edge.length, this.point);
        this.target.set(this.point.x, 0.8, this.point.z);
      }
    } else {
      const b = this.layout.bounds;
      this.target.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    }
    this.stage.aim(
      this.target,
      shot.radius,
      shot.phi,
      shot.theta + (still ? 0 : shot.turn * progress),
      this.kind.explained ? GLIDE : undefined,
    );
    this.stage.focus(shot.focus && !still);
  }
}

/** Nothing to draw but the frame of the demo. */
const EMPTY: OverlayState = {
  title: '',
  text: '',
  alpha: 0,
  progress: 0,
  card: null,
  cardAlpha: 0,
  status: '',
  large: false,
  step: null,
  badge: '',
  alert: '',
  counter: null,
  bottleneck: '',
  timeline: null,
  end: '',
  veil: 0,
};
