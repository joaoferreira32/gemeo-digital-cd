import type { FailureKind, SimEvent } from '../sim/failures';
import type { Kpis, RunReport } from '../sim/recorder';
import type { SimConfig } from '../sim/world';
import type { EntityHistory, Timeline } from './views';

export { STRESS_ARRIVAL_RATE } from '../sim/recorder';

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
  /** Shows a past moment of the recording (seconds); the live run waits. */
  | { type: 'seek'; time: number }
  /** Back to the head of the recording; the live run goes on. */
  | { type: 'live' }
  /** Continues the run from the moment shown, dropping what came after. */
  | { type: 'branch' }
  | { type: 'export'; what: 'csv' | 'report' }
  /** Runs a saved report again from scratch (fast forward, then checks the fingerprint). */
  | { type: 'load-report'; report: RunReport }
  /** History of an entity ("robot:3", "conveyor:7", "dock:2") at the moment shown. */
  | { type: 'history'; entity: string }
  /** Hands a snapshot buffer back for reuse. */
  | { type: 'release'; buffer: ArrayBuffer };

/** Messages from the simulation to the page. */
export type SimMessage =
  | { type: 'snapshot'; buffer: ArrayBuffer; events: SimEvent[] }
  | { type: 'status'; timeline: Timeline; kpis: Kpis; stages: number[] }
  | { type: 'history'; history: EntityHistory }
  | { type: 'export'; filename: string; mime: string; text: string }
  | { type: 'replay'; progress: number; done: boolean; ok?: boolean; fingerprint?: string }
  | { type: 'error'; message: string };

export const SPEEDS = [1, 4, 16] as const;
