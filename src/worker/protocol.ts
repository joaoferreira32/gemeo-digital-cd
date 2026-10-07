import type { Bottleneck } from '../ai/bottleneck';
import type { FailureKind, SimEvent } from '../sim/failures';
import type { Kpis, RunReport } from '../sim/recorder';
import type { SimConfig } from '../sim/world';
import type { AgentState, Comparison, PolicyChoice } from './routing';
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
  /** A conveyor starts wearing out (predictive maintenance demo). */
  | { type: 'wear' }
  | { type: 'stress'; on: boolean }
  /**
   * Who routes from now on. `model` is the URL of the trained network without
   * extension (the page knows where its files are; the worker does not).
   */
  | { type: 'policy'; policy: PolicyChoice; model?: string }
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
  | {
      type: 'status';
      timeline: Timeline;
      kpis: Kpis;
      stages: number[];
      routing: RoutingStatus;
      /** The bottleneck at the moment shown (src/ai/bottleneck.ts), or null. */
      bottleneck: Bottleneck | null;
      maintenance: MaintenanceStatus;
    }
  | { type: 'history'; history: EntityHistory }
  | { type: 'export'; filename: string; mime: string; text: string }
  | { type: 'replay'; progress: number; done: boolean; ok?: boolean; fingerprint?: string }
  | { type: 'error'; message: string };

export const SPEEDS = [1, 4, 16] as const;

/** The maintenance schedule at the moment shown (src/sim/schedule.ts). */
export interface MaintenanceStatus {
  readonly enabled: boolean;
  readonly avoided: number;
  /** Maintenance that found no wear (false alarms). */
  readonly unneeded: number;
  /** Belts that broke while their maintenance waited. */
  readonly lost: number;
  /** Labels of the belts with a maintenance planned (being emptied), and under way. */
  readonly planned: readonly string[];
  readonly inService: readonly string[];
}

export interface RoutingStatus {
  /** Who routes in the moment shown (the past keeps its own). */
  readonly shown: PolicyChoice;
  /** What the viewer asked for last (the network may still be loading). */
  readonly wanted: PolicyChoice;
  readonly agent: AgentState;
  readonly agentError: string;
  /** Mean time of a decision of the network (observation, inference, answer), ms; NaN before the first. */
  readonly decisionMs: number;
  readonly decisions: number;
  /** Live run against a copy that kept the static routing; null when static or in the past. */
  readonly compare: Comparison | null;
}
