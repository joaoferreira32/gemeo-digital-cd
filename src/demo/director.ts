import { Vector3 } from 'three';
import type { Bottleneck } from '../ai/bottleneck';
import type { SimEvent } from '../sim/failures';
import { pointOnEdge, type EdgePoint } from '../sim/graph';
import type { WarehouseLayout } from '../sim/layout';
import type { SimCommand, SimMessage } from '../worker/protocol';
import { beatAt, demoBeats, wallSeconds, type Beat } from './beats';
import { CARD_NOTE, CARD_SUBTITLE, CARD_TITLE, cardRows } from './card';
import type { OverlayState } from './overlay';
import { DEMO, type DemoResult, type DemoScript } from './run';

/**
 * The demo's director (phase 6), on the page: it follows the simulated time
 * being drawn and, beat by beat (src/demo/beats.ts), sets the speed, the
 * camera shot, the depth of field, the heat map and the caption; it takes the
 * run back in time when the run with AI has ended, and shows the final card
 * when the run without AI has too. It decides nothing about the simulation:
 * the worker plays the script at fixed ticks (src/demo/run.ts), so a slow
 * machine only makes the demo slower, never different.
 */

/** What the director moves on the page (main.ts gives it the scene). */
export interface DirectorStage {
  /** The camera glides to look at `target` from `radius` meters. */
  aim(target: Vector3, radius: number, phi: number, theta: number): void;
  /** A light depth of field on the camera's target, or none. */
  focus(on: boolean): void;
  heat(layer: 'off' | 'espera'): void;
  /** Where a working robot is (a new one when `pick`), or null without robots. */
  robot(pick: boolean): { readonly x: number; readonly z: number } | null;
  send(cmd: SimCommand): void;
}

export type DirectorPhase = 'off' | 'preparing' | 'ai' | 'rewind' | 'no-ai' | 'card';

/** Seconds a caption, and the card, take to fade in. */
const FADE = 0.4;

/** The caption of a beat with its live parts: the detector's words, the last event. */
export function captionText(beat: Beat, bottleneck: string, event: string): string {
  return beat.text
    .replace('{gargalo}', bottleneck || 'o detector lê a gravação segundo a segundo')
    .replace('{evento}', event || beat.idle || '')
    .trim();
}

export class Director {
  phase: DirectorPhase = 'off';
  readonly beats: readonly Beat[];
  private beat: Beat | null = null;
  /** Real seconds since the beat began, and since the demo began. */
  private beatWall = 0;
  private elapsed = 0;
  private compared = false;
  private result: DemoResult | null = null;
  private bottleneck = '';
  private event = '';
  private captionAlpha = 0;
  private cardAlpha = 0;
  private readonly total: number;
  private readonly target = new Vector3();
  private readonly point: EdgePoint = { x: 0, z: 0, heading: 0 };

  constructor(
    private readonly stage: DirectorStage,
    private readonly layout: WarehouseLayout,
    private readonly reducedMotion: () => boolean,
    readonly script: DemoScript = DEMO,
  ) {
    this.beats = demoBeats(script);
    this.total = wallSeconds(this.beats);
  }

  get active(): boolean {
    return this.phase !== 'off';
  }

  /** Real seconds the final card has been up (0 before it). */
  get cardSeconds(): number {
    return this.phase === 'card' ? this.beatWall : 0;
  }

  /** The beat being shown, if any. */
  get current(): Beat | null {
    return this.beat;
  }

  start(): void {
    this.phase = 'preparing';
    this.beat = null;
    this.beatWall = 0;
    this.elapsed = 0;
    this.compared = false;
    this.result = null;
    this.bottleneck = '';
    this.event = '';
    this.captionAlpha = 0;
    this.cardAlpha = 0;
    this.stage.send({ type: 'demo', action: 'start' });
  }

  /** Leaves the demo (the page goes back to the ordinary app). */
  stop(): void {
    if (this.phase === 'off') return;
    this.phase = 'off';
    this.beat = null;
    this.stage.focus(false);
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
      this.stage.send({ type: 'seek', time: this.script.branchAt });
    } else if (msg.phase === 'no-ai' && this.phase === 'rewind') {
      this.phase = 'no-ai';
    } else if (msg.phase === 'done' && this.phase === 'no-ai') {
      this.result = msg.result;
      this.phase = 'card';
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
    if (this.phase === 'preparing') {
      return {
        title: '',
        text: '',
        alpha: 0,
        progress: 0,
        card: null,
        cardAlpha: 0,
        status: 'Preparando a demo…',
      };
    }
    this.elapsed += realDt;
    const beat = this.beatFor(simTime);
    if (beat !== this.beat) this.enter(beat);
    this.beatWall += realDt;
    if (this.phase === 'rewind' && !this.compared && this.beatWall >= beat.hold) {
      this.compared = true;
      this.stage.send({ type: 'demo', action: 'compare' });
    }
    this.shoot(beat, simTime);
    const still = this.reducedMotion();
    this.captionAlpha = still ? 1 : Math.min(1, this.captionAlpha + realDt / FADE);
    const card = this.phase === 'card' && this.result;
    this.cardAlpha = card ? (still ? 1 : Math.min(1, this.cardAlpha + realDt / FADE)) : 0;
    return {
      title: card ? '' : beat.title,
      text: card ? '' : captionText(beat, this.bottleneck, this.event),
      alpha: this.captionAlpha,
      progress: Math.min(1, this.elapsed / this.total),
      card: card
        ? { title: CARD_TITLE, subtitle: CARD_SUBTITLE, rows: cardRows(card), note: CARD_NOTE }
        : null,
      cardAlpha: this.cardAlpha,
      status: '',
    };
  }

  private beatFor(simTime: number): Beat {
    const of = (id: Beat['id']) => this.beats.find((b) => b.id === id) as Beat;
    switch (this.phase) {
      case 'rewind':
        return of('volta');
      case 'card':
        return of('resultado');
      case 'no-ai':
        return beatAt(this.beats, 'no-ai', simTime);
      default:
        return beatAt(this.beats, 'ai', simTime);
    }
  }

  private enter(beat: Beat): void {
    this.beat = beat;
    this.beatWall = 0;
    this.event = '';
    this.captionAlpha = this.reducedMotion() ? 1 : 0;
    if (beat.speed > 0) this.stage.send({ type: 'speed', speed: beat.speed });
    this.stage.heat(beat.heat);
    if (beat.shot.target.kind === 'robot') this.stage.robot(true);
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
    } else {
      const b = this.layout.bounds;
      this.target.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    }
    this.stage.aim(
      this.target,
      shot.radius,
      shot.phi,
      shot.theta + (still ? 0 : shot.turn * progress),
    );
    this.stage.focus(shot.focus && !still);
  }
}
