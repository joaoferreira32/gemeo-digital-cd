import type { Conveyor } from './conveyor';
import type { BypassLane } from './fleet';
import { shortestPathTree, type Graph } from './graph';
import type { SplitRouter } from './routing';

/**
 * Who sets the routing shares: nobody (the static shortest path), the
 * congestion heuristic below, or something outside the simulation (the
 * reinforcement learning agent), through recorded inputs.
 */
export type RoutingPolicy = 'static' | 'heuristic' | 'external';
export const ROUTING_POLICIES: readonly RoutingPolicy[] = ['static', 'heuristic', 'external'];

export interface HeuristicParams {
  /** Weight of the queue already waiting on a belt against its travel time. */
  readonly delayWeight: number;
  /** Seconds of cost difference that take the target share from 50% to 73%. */
  readonly temperature: number;
  /** Fraction of the gap to the target share closed each second (0 … 1). */
  readonly smoothing: number;
}

/**
 * Calibrated on the validation seeds (`npm run bench:rotas -- --calibrate`):
 * the best mean p95 gain of a 3 × 3 grid. The optimum is flat (the nine
 * pairs are within 2 points of each other), so the choice is not fragile.
 */
export const DEFAULT_HEURISTIC: HeuristicParams = {
  delayWeight: 0.5,
  temperature: 0.5,
  smoothing: 0.3,
};

/** Robots bridging a broken belt move about this many packets per second (phase 2 measure). */
const BYPASS_RATE = 0.45;

/**
 * Congestion-aware routing. For each choice, the expected time from the
 * junction to the merge behind the destination docks along each way: travel
 * time plus the queue already waiting on each belt (packets that could not
 * move ÷ the belt's outflow), infinite through a broken belt that robots do
 * not bridge. The share of the alternative way follows a logistic of the
 * cost difference and moves toward it gradually, so the flow does not flip
 * back and forth. When one way is cut (a broken belt nobody bridges) the
 * share jumps to the other at once: a packet sent that way would only wait
 * in front of the broken belt until the repair.
 */
export class HeuristicRouting {
  /** Belts of each way, per decision: the first belt, then the static path to the merge. */
  readonly ways: { primary: number[]; alternative: number[] }[];
  /** Expected seconds along each way at the last update, per decision (panels, tests). */
  readonly cost: { primary: number; alternative: number }[];

  constructor(
    graph: Graph,
    private readonly router: SplitRouter,
    private readonly params: HeuristicParams,
  ) {
    const trees = new Map<number, Int32Array>();
    const pathTo = (from: number, target: number) => {
      let tree = trees.get(target);
      if (!tree) {
        tree = shortestPathTree(graph, target, (e) => e.length).next;
        trees.set(target, tree);
      }
      const out: number[] = [];
      for (let n = from, guard = 0; n !== target && guard < graph.nodes.length; guard++) {
        const e = tree[n] as number;
        if (e < 0) break;
        out.push(e);
        n = graph.edge(e).to;
      }
      return out;
    };
    this.ways = router.decisions.map((d) => ({
      primary: [d.primary, ...pathTo(graph.edge(d.primary).to, d.side)],
      alternative: [d.alternative, ...pathTo(graph.edge(d.alternative).to, d.side)],
    }));
    this.cost = router.decisions.map(() => ({ primary: 0, alternative: 0 }));
  }

  /** Recomputes the target shares from the belts as they are and moves the shares toward them. */
  update(conveyors: readonly Conveyor[], lanes: readonly BypassLane[]): void {
    const laneOf = new Map(lanes.map((l) => [l.edgeId, l]));
    const edgeCost = (e: number) => {
      const c = conveyors[e] as Conveyor;
      const travel = c.length / c.speed;
      if (c.status !== 'ok') {
        const lane = laneOf.get(e);
        if (!lane?.active) return Infinity;
        return travel + (lane.pickup.length + 1) / BYPASS_RATE;
      }
      let blocked = 0;
      for (const p of c.packets) if (p.blocked) blocked++;
      return travel + (this.params.delayWeight * blocked * c.spacing) / c.speed;
    };
    const wayCost = (way: readonly number[]) => way.reduce((sum, e) => sum + edgeCost(e), 0);
    const { temperature, smoothing } = this.params;
    this.ways.forEach((way, i) => {
      const cp = wayCost(way.primary);
      const ca = wayCost(way.alternative);
      this.cost[i] = { primary: cp, alternative: ca };
      const share = this.router.share;
      if (!Number.isFinite(cp) && !Number.isFinite(ca)) return;
      if (!Number.isFinite(cp)) {
        share[i] = 1;
        return;
      }
      if (!Number.isFinite(ca)) {
        share[i] = 0;
        return;
      }
      const target = 1 / (1 + Math.exp((ca - cp) / temperature));
      share[i] = (share[i] as number) + smoothing * (target - (share[i] as number));
    });
  }
}
