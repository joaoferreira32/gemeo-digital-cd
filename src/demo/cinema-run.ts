import { BottleneckDetector, topologyOf, type Bottleneck } from '../ai/bottleneck';
import type { SimEvent } from '../sim/failures';
import { waitingFor } from '../sim/queues';
import { Recorder, type SimInput } from '../sim/recorder';
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
  private readonly inputs: { tick: number; input: SimInput }[];
  private next = 0;
  private readonly perSecond: number;
  private lastEventId = 0;
  /** Scratch for the queues of every belt and dock (src/sim/queues.ts). */
  private readonly conveyorQueues: Int32Array;
  private readonly dockQueues: Int32Array;
  /** Times the run went back to an earlier moment (the page draws a cut there). */
  jumps = 0;

  constructor(
    readonly side: CinemaSide,
    readonly script: DemoScript = DEMO_EXPLICADA,
  ) {
    this.rec = new Recorder(demoConfig(script));
    this.conveyorQueues = new Int32Array(this.rec.live.conveyors.length);
    this.dockQueues = new Int32Array(this.rec.live.docks.length);
    this.perSecond = Math.round(1 / this.rec.config.dt);
    this.inputs = demoInputs(script)
      .filter((x) => side === 'ai' || !x.ai)
      .map(({ at, input }) => ({ tick: this.tick(at), input }));
    // Until the AI takes over, the routing is the static one (as in the explained demo).
    this.rec.input({ type: 'policy', policy: 'static' });
    this.detector = new BottleneckDetector(topologyOf(this.rec.live));
    this.stepTo(this.tick(script.warmup));
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
      this.jumps++;
    }
    this.stepTo(target);
  }

  private stepTo(target: number): void {
    const rec = this.rec;
    for (;;) {
      while (this.next < this.inputs.length) {
        const x = this.inputs[this.next] as { tick: number; input: SimInput };
        if (x.tick !== rec.headTick) break;
        rec.input(x.input);
        this.next++;
      }
      if (rec.headTick >= target) return;
      rec.step();
    }
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
