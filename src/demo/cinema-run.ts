import { BottleneckDetector, topologyOf, type Bottleneck } from '../ai/bottleneck';
import type { SimEvent } from '../sim/failures';
import type { World } from '../sim/world';
import { waitingFor } from '../sim/queues';
import { Recorder, type SimInput } from '../sim/recorder';
import { LOG_TEXT, type CinemaLogLine } from './cinema';
import {
  DEMO_EXPLICADA,
  demoConfig,
  demoInputs,
  measure,
  type DemoScript,
  type DemoSide,
} from './run';

/**
 * One side of the cinema demo (src/demo/cinema.ts): the explained demo's
 * script (Esteira 8 breaks at 104 s, the motor of Esteira 16 wears from
 * 118 s) with the AI taking over at 128 s (the 'ai' side) or never (the
 * 'no-ai' side). Until the AI takes over the two are the same run, bit for
 * bit, so the split screen starts from one world.
 *
 * It has no clock: the page asks for the simulated moment of each video
 * frame (`to`) and draws it, so every frame shows its exact moment, on any
 * machine, and a recording comes out with 60 frames per second exactly.
 * Forward it steps; backward (the full version's "volta no tempo") it goes
 * back through its own recording and goes on from there, as the time travel
 * of the app does.
 */

export type CinemaSide = 'ai' | 'no-ai';

export class CinemaRun {
  readonly rec: Recorder;
  /** Reads the recording: the bottleneck at the moment shown. */
  private readonly detector: BottleneckDetector;
  private readonly inputs: { tick: number; input: SimInput; ai: boolean }[];
  private next = 0;
  private readonly perSecond: number;
  private lastEventId = 0;
  /** Scratch for the queues of every belt and dock (src/sim/queues.ts). */
  private readonly conveyorQueues: Int32Array;
  private readonly dockQueues: Int32Array;
  /** Times the run went back to an earlier moment (the page draws a cut there). */
  jumps = 0;
  /**
   * Called at every tick the run reaches going forward, its inputs applied
   * (the worker keeps the moments a rewind will show).
   */
  onTick: (() => void) | null = null;
  /**
   * The AI's log, written from the engine as the run goes (texts: LOG_TEXT):
   * the AI taking over (the script's input), each way of a routing choice
   * that carried packets cut by a stopped belt (its cost goes infinite) and
   * back, and each maintenance scheduled on a motor's alarm. A way cut while
   * no packet took it changes nothing, and is not written.
   */
  readonly log: CinemaLogLine[] = [];
  /** Per routing choice and way (primary, alternative): the belt cutting it at the last decision, or −1. */
  private readonly cutBy: Int32Array;
  /** Per routing choice and way: its cut was written (its return is written too). */
  private readonly told: Uint8Array;
  /** Per routing choice: the share of the alternative way before the router's last decision. */
  private readonly before: Float64Array;
  private logEventId = 0;
  /** When the router last decided (s; it decides on every whole second while the AI routes), or −1. */
  private decidedAt = -1;

  constructor(
    readonly side: CinemaSide,
    readonly script: DemoScript = DEMO_EXPLICADA,
    /** Where the run starts being shown (s): it is played up to there at once. */
    warmup = script.warmup,
  ) {
    this.rec = new Recorder(demoConfig(script));
    this.conveyorQueues = new Int32Array(this.rec.live.conveyors.length);
    this.dockQueues = new Int32Array(this.rec.live.docks.length);
    this.perSecond = Math.round(1 / this.rec.config.dt);
    this.inputs = demoInputs(script)
      .filter((x) => side === 'ai' || !x.ai)
      .map(({ at, input, ai }) => ({ tick: this.tick(at), input, ai: ai === true }));
    const choices = this.rec.live.routing.decisions.length;
    this.cutBy = new Int32Array(choices * 2).fill(-1);
    this.told = new Uint8Array(choices * 2);
    this.before = new Float64Array(choices);
    // Until the AI takes over, the routing is the static one (as in the explained demo).
    this.rec.input({ type: 'policy', policy: 'static' });
    this.detector = new BottleneckDetector(topologyOf(this.rec.live));
    this.stepTo(this.tick(warmup));
    this.lastEventId = this.rec.events.at(-1)?.id ?? 0;
  }

  tick(seconds: number): number {
    return Math.round(seconds * this.perSecond);
  }

  /** The simulated time shown (s): the head, or a past moment a test looks at. */
  get time(): number {
    return this.rec.shown.tick / this.perSecond;
  }

  /**
   * Shows the moment `time` (s): steps forward to it, or goes back to it and
   * goes on from there (what was recorded after it is dropped, and played
   * again by the same script). The inputs of that tick are applied.
   */
  to(time: number): void {
    const target = this.tick(time);
    const rec = this.rec;
    if (target < rec.headTick) {
      rec.seek(target);
      rec.branch();
      this.next = this.inputs.findIndex((x) => x.tick > target);
      if (this.next < 0) this.next = this.inputs.length;
      this.lastEventId = rec.events.at(-1)?.id ?? 0;
      // The log as it was at that moment (the same script writes the rest again).
      const kept = this.log.findIndex((l) => this.tick(l.at) > target);
      if (kept >= 0) this.log.length = kept;
      this.logEventId = this.lastEventId;
      this.resyncCuts(rec.live);
      this.jumps++;
    }
    this.stepTo(target);
  }

  private stepTo(target: number): void {
    const rec = this.rec;
    for (;;) {
      while (this.next < this.inputs.length) {
        const x = this.inputs[this.next] as { tick: number; input: SimInput; ai: boolean };
        if (x.tick !== rec.headTick) break;
        rec.input(x.input);
        if (x.ai && x.input.type === 'policy') {
          const at = rec.headTick / this.perSecond;
          this.log.push({ at, kind: 'assume', text: LOG_TEXT.assume(at) });
        }
        this.next++;
      }
      this.onTick?.();
      if (rec.headTick >= target) return;
      rec.step();
      // The router decides, and the motors are read, on every whole second.
      if (rec.headTick % this.perSecond === 0) {
        if (rec.live.policy === 'heuristic') this.decidedAt = rec.headTick / this.perSecond;
        this.readCuts(rec.live);
        this.readMaintenance();
      }
    }
  }

  /**
   * The ways the router's last decision found cut (a cost gone infinite: a
   * stopped belt nobody bridges) and those back again: a line of the log for
   * each junction and belt, when the way carried packets before the decision.
   */
  private readCuts(w: World): void {
    if (w.policy !== 'heuristic') return;
    const at = w.tick / this.perSecond;
    const graph = w.layout.graph;
    // A way the flow was using (the primary) first: that cut moves the flow.
    const cut = new Map<string, { text: string; way: number }>();
    const back = new Map<string, { text: string; way: number }>();
    w.routing.decisions.forEach((d, i) => {
      const cost = w.heuristic.cost[i];
      const ways = w.heuristic.ways[i];
      if (!cost || !ways) return;
      const node = graph.node(d.node).name;
      ([0, 1] as const).forEach((k) => {
        const way = k === 0 ? ways.primary : ways.alternative;
        const other = k === 0 ? ways.alternative : ways.primary;
        const finite = Number.isFinite(k === 0 ? cost.primary : cost.alternative);
        const was = this.cutBy[i * 2 + k] as number;
        const share = this.before[i] as number;
        const carried = (k === 0 ? 1 - share : share) > 1e-9;
        if (!finite && was < 0) {
          const belt = this.blocking(w, way);
          this.cutBy[i * 2 + k] = belt.id;
          this.told[i * 2 + k] = carried ? 1 : 0;
          if (!carried) return;
          cut.set(`${node}|${belt.id}`, {
            text: LOG_TEXT.corte(at, node, `Esteira ${belt.id + 1}`, belt.state, lineOf(w, other)),
            way: k,
          });
        } else if (finite && was >= 0) {
          this.cutBy[i * 2 + k] = -1;
          if (!this.told[i * 2 + k]) return;
          this.told[i * 2 + k] = 0;
          back.set(`${node}|${was}`, {
            text: LOG_TEXT.retorno(at, node, `Esteira ${was + 1}`),
            way: k,
          });
        }
      });
    });
    this.before.set(w.routing.share);
    const byWay = (a: { way: number }, b: { way: number }) => a.way - b.way;
    for (const { text } of [...cut.values()].sort(byWay))
      this.log.push({ at, kind: 'corte', text });
    for (const { text } of [...back.values()].sort(byWay)) {
      this.log.push({ at, kind: 'retorno', text });
    }
  }

  /**
   * After going back in time: the ways cut at the router's last decision of
   * the moment shown (none while it was not deciding), so the lines written
   * again are the same as the first time.
   */
  private resyncCuts(w: World): void {
    this.cutBy.fill(-1);
    this.told.fill(0);
    this.before.set(w.routing.share);
    // The router's last decision at that moment: its last whole second (it decides on them).
    this.decidedAt = -1;
    if (w.policy !== 'heuristic') return;
    const last = Math.floor(w.tick / this.perSecond);
    if (
      this.inputs.some((x) => x.ai && x.input.type === 'policy' && x.tick < last * this.perSecond)
    ) {
      this.decidedAt = last;
    }
    w.routing.decisions.forEach((_, i) => {
      const cost = w.heuristic.cost[i];
      const ways = w.heuristic.ways[i];
      if (!cost || !ways) return;
      const node = w.layout.graph.node(w.routing.decisions[i]!.node).name;
      ([0, 1] as const).forEach((k) => {
        if (Number.isFinite(k === 0 ? cost.primary : cost.alternative)) return;
        const belt = this.blocking(w, k === 0 ? ways.primary : ways.alternative).id;
        this.cutBy[i * 2 + k] = belt;
        // Written then if a line of it is still in the log.
        const line = `${node}: Esteira ${belt + 1} `;
        this.told[i * 2 + k] = this.log.some((l) => l.kind === 'corte' && l.text.includes(line))
          ? 1
          : 0;
      });
    });
  }

  /** The belt that cuts a way, and how: stopped (broken) or stopped for maintenance. */
  private blocking(w: World, way: readonly number[]): { id: number; state: string } {
    for (const e of way) {
      const c = w.conveyors[e];
      if (!c) continue;
      if (w.schedule.closing[e]) return { id: e, state: 'em manutenção' };
      const bridged = w.lanes.some((l) => l.edgeId === e && l.active);
      if (c.status !== 'ok' && !bridged) {
        return { id: e, state: c.status === 'broken' ? 'parada' : 'em manutenção' };
      }
    }
    return { id: way[0] ?? 0, state: 'parada' };
  }

  /** A maintenance the AI scheduled on a motor's alarm (the two events of the same second). */
  private readMaintenance(): void {
    const events = this.rec.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i] as SimEvent;
      if (e.id <= this.logEventId) break;
      if (e.kind !== 'service-planned' || e.target === undefined) continue;
      const alarm = events.some(
        (x) => x.kind === 'maintenance' && x.target === e.target && x.time === e.time,
      );
      if (alarm) {
        this.log.push({
          at: e.time,
          kind: 'manutencao',
          text: LOG_TEXT.manutencao(e.time, `Esteira ${e.target + 1}`),
        });
      }
    }
    this.logEventId = events.at(-1)?.id ?? this.logEventId;
  }

  /**
   * The router's costs at the moment shown (expected seconds on each way of
   * each choice: primary, alternative, …), whether the AI routes, and when the
   * router last decided (−1 before its first decision).
   */
  routing(): { active: boolean; decidedAt: number; cost: number[] } {
    const w = this.rec.shown;
    const active = w.policy === 'heuristic';
    return {
      active,
      decidedAt: active ? this.decidedAt : -1,
      cost: w.heuristic.cost.flatMap((c) => [c.primary, c.alternative]),
    };
  }

  /**
   * Packets delivered in the minute before the moment shown (the tour's
   * "entregas por minuto"): the recording's count, second by second.
   */
  deliveredLastMinute(): number {
    const d = this.rec.series.delivered;
    const second = Math.min(Math.floor(this.time + 1e-9), this.rec.series.seconds - 1);
    return d.get(second) - d.get(Math.max(0, second - 60));
  }

  /** Events since the previous call (the page shows some of them). */
  newEvents(): SimEvent[] {
    const out = this.rec.events.filter((e) => e.id > this.lastEventId);
    const last = out.at(-1);
    if (last) this.lastEventId = last.id;
    return out;
  }

  /** The detector's finding at the moment shown (it reads the recording up to that second). */
  bottleneck(): Bottleneck | null {
    return this.detector.detect(this.rec.series, Math.floor(this.time + 1e-9));
  }

  /** The card's measures from the breakdown to the moment shown (they count up as the run goes). */
  measures(): DemoSide {
    return measure(this.rec, this.script.failure.at, Math.floor(this.time + 1e-9));
  }

  /**
   * The queue of the belt that broke, at the moment shown, as the detector
   * counts a belt's queue (src/sim/queues.ts): the packets stopped on it and
   * those held before it waiting for it. The counter on screen: the queue in
   * the scene, not the packets waiting anywhere in the warehouse (the AI's
   * detour makes queues of its own elsewhere, which the X-ray shows).
   */
  queue(): number {
    waitingFor(this.rec.shown, this.conveyorQueues, this.dockQueues, 'next');
    return this.conveyorQueues[this.script.failure.target] as number;
  }
}

/** The line a way goes onto: "linha A", "linha B" (by the junction its first belt reaches). */
function lineOf(w: World, way: readonly number[]): string {
  const first = way[0];
  if (first === undefined) return '';
  const name = w.layout.graph.node(w.layout.graph.edge(first).to).name;
  return /^[AB]\d/.test(name) ? `linha ${name[0]}` : name;
}
