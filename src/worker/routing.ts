import { createAgent, type Agent, type AgentInfo } from '../ai/agent';
import type { SimInput } from '../sim/recorder';
import type { RoutingPolicy } from '../sim/policy';
import { World } from '../sim/world';

/** What the viewer picks with the P key; the learning agent runs as the "external" policy. */
export type PolicyChoice = 'static' | 'heuristic' | 'rl';
export const POLICY_CHOICES: readonly PolicyChoice[] = ['static', 'heuristic', 'rl'];

export function policyOf(choice: PolicyChoice): RoutingPolicy {
  return choice === 'rl' ? 'external' : choice;
}

export function choiceOf(policy: RoutingPolicy): PolicyChoice {
  return policy === 'external' ? 'rl' : policy;
}

export type AgentState = 'idle' | 'loading' | 'ready' | 'error';

/** Fetches the network (`url` without extension) and starts it on onnxruntime-web. */
export type AgentLoader = (url: string) => Promise<Agent>;

export const loadAgent: AgentLoader = async (url) => {
  // The WebAssembly-only build (14 MB, against 28 MB with WebGPU): a tiny network runs fine on the CPU.
  const ort = await import('onnxruntime-web/wasm');
  // No shared memory on a static host (GitHub Pages): one thread.
  ort.env.wasm.numThreads = 1;
  const [model, info] = await Promise.all([
    fetch(`${url}.onnx`).then((r) => {
      if (!r.ok) throw new Error(`modelo não encontrado (${r.status})`);
      return r.arrayBuffer();
    }),
    fetch(`${url}.json`).then((r) => r.json() as Promise<AgentInfo>),
  ]);
  return createAgent(ort, new Uint8Array(model), info);
};

/**
 * The trained routing network, loaded the first time it is asked for: the
 * onnxruntime-web code and its WebAssembly are fetched only then, so the page
 * does not pay for them otherwise.
 */
export class LazyAgent {
  state: AgentState = 'idle';
  error = '';
  private agent: Agent | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly loader: AgentLoader = loadAgent) {}

  /** `url` is the model's URL without extension (".onnx" and ".json" are added). */
  load(url: string, onDone: () => void): void {
    if (this.agent || this.loading) return;
    this.state = 'loading';
    this.loading = (async () => {
      try {
        this.agent = await this.loader(url);
        this.state = 'ready';
      } catch (e) {
        this.state = 'error';
        this.error = (e as Error).message;
      } finally {
        this.loading = null;
        onDone();
      }
    })();
  }

  get ready(): Agent | null {
    return this.agent;
  }
}

export interface Measures {
  /** Mean cycle of the deliveries of the last two minutes (s). */
  readonly cycle: number;
  /** Deliveries per minute over the last two minutes. */
  readonly throughput: number;
  /** Packets queuing now. */
  readonly waiting: number;
  /** Deliveries since the comparison began. */
  readonly delivered: number;
}

export interface Comparison {
  /** Simulated time when the comparison began (the switch away from the static routing). */
  readonly since: number;
  readonly live: Measures;
  /** The same run from that moment, with the static routing. */
  readonly shadow: Measures;
}

/**
 * A copy of the live world taken when the viewer leaves the static routing,
 * which goes on with the static routing and the same inputs (failures,
 * load test): the panel compares the two from that moment. Not recorded;
 * dropped while a past moment is shown and taken again on return.
 */
export class StaticShadow {
  private world: World | null = null;
  private since = 0;
  private liveStart = 0;
  private shadowStart = 0;

  get active(): boolean {
    return this.world !== null;
  }

  start(live: World): void {
    const w = new World(live.config, live.layout);
    w.loadState(live.saveState());
    w.setPolicy('static');
    this.world = w;
    this.since = live.time;
    this.liveStart = live.metrics.delivered;
    this.shadowStart = w.metrics.delivered;
  }

  stop(): void {
    this.world = null;
  }

  step(): void {
    this.world?.step();
  }

  /** The live world's inputs, except who routes (the shadow keeps the static routing). */
  apply(input: SimInput, apply: (w: World, input: SimInput) => void): void {
    if (!this.world || input.type === 'policy' || input.type === 'shares') return;
    apply(this.world, input);
  }

  compare(live: World): Comparison | null {
    const w = this.world;
    if (!w) return null;
    const measures = (x: World, start: number): Measures => ({
      cycle: x.metrics.windowMeanCycleTime,
      throughput: x.metrics.throughputPerMinute(x.time),
      waiting: x.stats.waiting,
      delivered: x.metrics.delivered - start,
    });
    return {
      since: this.since,
      live: measures(live, this.liveStart),
      shadow: measures(w, this.shadowStart),
    };
  }
}
