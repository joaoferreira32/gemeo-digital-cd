import type { FailureKind, SimEvent } from '../sim/failures';
import type { SimConfig } from '../sim/world';

/** Messages from the page to the simulation (worker or inline host). */
export type SimCommand =
  | { type: 'init'; config?: Partial<SimConfig> }
  | { type: 'restart' }
  /** Simulated seconds per real second; 0 pauses. */
  | { type: 'speed'; speed: number }
  | { type: 'inject'; kind: FailureKind; target?: number }
  | { type: 'auto'; on: boolean }
  | { type: 'stress'; on: boolean }
  /** Jumps ahead `seconds` of simulated time at once (tools and tests). */
  | { type: 'advance'; seconds: number }
  /** Hands a snapshot buffer back for reuse. */
  | { type: 'release'; buffer: ArrayBuffer };

/** Messages from the simulation to the page. */
export type SimMessage =
  | { type: 'snapshot'; buffer: ArrayBuffer; events: SimEvent[] }
  | { type: 'error'; message: string };

/** Order rate used by the load test: far above capacity, so piles grow past 2 000 packets. */
export const STRESS_ARRIVAL_RATE = 40;
export const SPEEDS = [1, 4, 16] as const;
