import type { LabMetrics, LabScenario } from './run';

/** One run asked of a lab worker. */
export interface LabRequest {
  readonly id: number;
  readonly scenario: LabScenario;
  readonly seed: number;
  readonly seconds: number;
  readonly weights?: readonly number[];
  readonly startHour?: number;
  /** URL of the routing network without extension (trained policy). */
  readonly modelUrl?: string;
}

export type LabReply =
  | { readonly id: number; readonly metrics: LabMetrics }
  | { readonly id: number; readonly error: string };

export type LabOutcome = { readonly metrics: LabMetrics } | { readonly error: string };

/** What the pool needs from a worker (a Web Worker in the page, a stand-in in the tests). */
export interface WorkerLike {
  postMessage(request: LabRequest): void;
  onmessage: ((e: { data: LabReply }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  terminate(): void;
}

/**
 * Runs lab jobs on a few workers at once. Results come back in the order of
 * the jobs, whatever the number of workers and whoever finishes first: each
 * run is a function of its scenario and seed alone. A job that fails gives
 * its error and the others go on; a worker that crashes is replaced. Cancel
 * stops everything at once (the workers are terminated).
 */
export class LabPool {
  private workers: (WorkerLike | undefined)[] = [];
  private stop: ((e: Error) => void) | null = null;
  private generation = 0;

  constructor(
    readonly size: number,
    private readonly spawn: () => WorkerLike,
  ) {
    if (!(size >= 1)) throw new Error('a lab pool needs at least one worker');
  }

  run(
    requests: readonly Omit<LabRequest, 'id'>[],
    /** After each job: how many are done, of how many, and which job gave what. */
    onProgress?: (done: number, total: number, index: number, outcome: LabOutcome) => void,
  ): Promise<LabOutcome[]> {
    const generation = ++this.generation;
    // A run still pending is over: its results would no longer be wanted.
    this.stop?.(new Error('substituído por outra rodada'));
    return new Promise((resolve, reject) => {
      this.stop = reject;
      const total = requests.length;
      const results = new Array<LabOutcome>(total);
      if (total === 0) {
        resolve(results);
        return;
      }
      let next = 0;
      let done = 0;
      const live = () => generation === this.generation;
      const finish = (slot: number, index: number, outcome: LabOutcome) => {
        if (!live() || results[index]) return;
        results[index] = outcome;
        done++;
        onProgress?.(done, total, index, outcome);
        if (done === total) {
          this.stop = null;
          resolve(results);
        } else {
          feed(slot);
        }
      };
      const feed = (slot: number) => {
        if (!live() || next >= total) return;
        const index = next++;
        let worker = this.workers[slot];
        if (!worker) {
          worker = this.spawn();
          this.workers[slot] = worker;
        }
        const w = worker;
        w.onmessage = (e) => {
          const reply = e.data;
          if (reply.id !== index) return;
          finish(
            slot,
            index,
            'metrics' in reply ? { metrics: reply.metrics } : { error: reply.error },
          );
        };
        w.onerror = (e) => {
          // A crashed worker is not reused: the next job gets a new one.
          w.terminate();
          if (this.workers[slot] === w) this.workers[slot] = undefined;
          finish(slot, index, { error: errorText(e) });
        };
        w.postMessage({ ...(requests[index] as Omit<LabRequest, 'id'>), id: index });
      };
      for (let slot = 0; slot < Math.min(this.size, total); slot++) feed(slot);
    });
  }

  /** Stops the runs under way: the workers are terminated, the pending promise is rejected. */
  cancel(): void {
    this.generation++;
    this.dispose();
    const stop = this.stop;
    this.stop = null;
    stop?.(new Error('cancelado'));
  }

  dispose(): void {
    for (const w of this.workers) w?.terminate();
    this.workers = [];
  }
}

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e)
    return String((e as { message: unknown }).message);
  return String(e);
}

/** A Web Worker of the page as a pool worker. */
export function adaptWorker(worker: Worker): WorkerLike {
  const like: WorkerLike = {
    postMessage: (request) => worker.postMessage(request),
    onmessage: null,
    onerror: null,
    terminate: () => worker.terminate(),
  };
  worker.onmessage = (e: MessageEvent<LabReply>) => like.onmessage?.({ data: e.data });
  worker.onerror = (e) => like.onerror?.(e);
  return like;
}
