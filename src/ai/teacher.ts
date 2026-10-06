import type { World } from '../sim/world';
import { ACTION_LEVELS } from './env';

/**
 * The heuristic as a teacher of the learning agent: what it would do, in the
 * agent's terms (a level per routing choice, share = level ÷ 4). It keeps its
 * own continuous shares from one second to the next, so rounding them to
 * levels does not stall its gradual moves (from 0, a step of 0.18 rounds
 * back to 0 forever). The world's shares are left as they were.
 */
export class HeuristicTeacher {
  private readonly shares: Float64Array;
  private readonly saved: Float64Array;

  constructor(world: World) {
    this.shares = new Float64Array(world.routing.decisions.length);
    this.saved = new Float64Array(this.shares.length);
  }

  /** The levels for the coming second, from the world as it is now. */
  levels(world: World): number[] {
    const share = world.routing.share;
    this.saved.set(share);
    share.set(this.shares);
    world.heuristic.update(world.conveyors, world.lanes);
    this.shares.set(share);
    share.set(this.saved);
    return Array.from(this.shares, (s) => Math.round(s * (ACTION_LEVELS - 1)));
  }
}
