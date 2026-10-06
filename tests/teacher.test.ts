import { describe, expect, it } from 'vitest';
import { RoutingEnv } from '../src/ai/env';
import { HeuristicTeacher } from '../src/ai/teacher';
import { World } from '../src/sim/world';

const SECOND = 60;

describe('Heuristic teacher (imitation start of the learning agent)', () => {
  it('gives the heuristic levels without touching the shares of the world', () => {
    const w = new World({ seed: 10_201 });
    w.setPolicy('external');
    w.stepMany(60 * SECOND);
    w.setShares([0.25, 0, 0, 0, 0.5]);
    const before = Array.from(w.routing.share);
    const teacher = new HeuristicTeacher(w);
    const levels = teacher.levels(w);
    expect(Array.from(w.routing.share)).toEqual(before);
    expect(levels).toHaveLength(5);
    for (const l of levels) expect([0, 1, 2, 3, 4]).toContain(l);
  });

  it('like the heuristic, sends everything the other way at once when a way is cut', () => {
    const w = new World({ seed: 10_201, robotBypass: false });
    w.setPolicy('external');
    w.stepMany(30 * SECOND);
    const teacher = new HeuristicTeacher(w);
    // Esteira 8 (B2→B3) is on the static way of "B2 → Docas 4–6" and nobody bridges it.
    w.setConveyorStatus(7, 'broken');
    const d = w.routing.decisions.findIndex((x) => x.label === 'B2 → Docas 4–6');
    expect(teacher.levels(w)[d]).toBe(4);
  });

  it('a run driven by the teacher is deterministic', () => {
    const run = () => {
      const env = new RoutingEnv();
      env.reset(10_202, 'esteira', 240);
      const teacher = new HeuristicTeacher(env.world);
      while (!env.step(teacher.levels(env.world)).done);
      return env.result();
    };
    expect(run()).toEqual(run());
  }, 60_000);
});
