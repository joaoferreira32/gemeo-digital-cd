import { describe, expect, it } from 'vitest';
import type { Fleet } from '../src/sim/fleet';
import {
  FACE_TO_FACE_PLACEMENTS,
  SINGLE_ENTRANCE_GATES,
  brokenGate,
  faceToFace,
  runScenario as run,
  swapPlaces,
} from '../src/sim/scenarios';
import { World } from '../src/sim/world';

/** Seconds without a path before the watchdog acts (the default). */
const PERIOD = 6;
/** Robots' bounding circles never overlap above this distance between centers. */
const SAFE_DISTANCE = 0.89;

function scene(robots: number, fleet: { stepAside?: boolean; watchdogSeconds?: number }) {
  const w = new World({ robots, rackOrderRate: 0, fleet });
  const f = w.fleet as Fleet;
  const cell = (x: number, z: number) => f.grid.cellOf(x, z);
  return { w, f, cell };
}

describe('Watchdog: two robots waiting for each other, step-aside requests failing', () => {
  it('is a real deadlock: without the watchdog neither robot moves for 2 minutes', () => {
    const { w, f } = scene(4, { stepAside: false, watchdogSeconds: 0 });
    faceToFace(f, -6);
    const r = run(w, 120, [0, 1]);
    expect(r.crossed.size).toBe(0);
    expect(f.robots[0]!.motion.x).toBe(11);
    expect(f.robots[1]!.motion.x).toBe(13);
    expect(r.wait.get(0)).toBeGreaterThanOrEqual(118);
    expect(f.stats.evades).toBe(0);
  }, 60_000);

  it('breaks it in bounded time at every single-entrance gate (36 cases)', () => {
    // Bound: detection after PERIOD s, up to 1 s to the next planning round,
    // back-off of at most 4 steps, the robot that backed off waits 4 s and
    // crosses back in at most 5 steps: 6 + 1 + 4 + 4 + 5 = 20 s.
    const BOUND = 20;
    let worst = 0;
    let cases = 0;
    for (const z of SINGLE_ENTRANCE_GATES) {
      for (const at of FACE_TO_FACE_PLACEMENTS) {
        for (const loaded of ['none', 'west', 'east'] as const) {
          const { w, f } = scene(4, { stepAside: false, watchdogSeconds: PERIOD });
          faceToFace(f, z, at, loaded);
          const r = run(w, 40, [0, 1]);
          const label = `gate z=${z} at ${at.join('/')} loaded ${loaded}`;
          expect(r.crossed.size, label).toBe(2);
          const resolved = Math.max(...r.crossed.values()) - r.firstFailure;
          expect(resolved, label).toBeLessThanOrEqual(BOUND);
          expect(r.minDistance, label).toBeGreaterThanOrEqual(SAFE_DISTANCE);
          expect(r.braking, label).toBe(0);
          expect(f.stats.cyclesBroken, label).toBe(1);
          expect(f.stats.cyclesStalled, label).toBe(0);
          worst = Math.max(worst, resolved);
          cases++;
        }
      }
    }
    console.info(
      `impasse mútuo: ${cases} casos, pior tempo até os dois cruzarem ${worst.toFixed(1)} s`,
    );
  }, 120_000);

  it('the robot that backs off is the one that gets out of the way fastest', () => {
    // The east robot stands inside the gate: it would have to reverse (two
    // waits) to back off, the west one only turns (one wait).
    const { w, f } = scene(4, { stepAside: false, watchdogSeconds: PERIOD });
    faceToFace(f, 12, [11, 12]);
    run(w, 12, [0, 1]);
    const event = w.events.find((e) => e.kind === 'watchdog');
    expect(event?.text).toBe(
      'Vigia: Robôs 1 e 2 esperavam um pelo outro; o Robô 1 recuou para abrir passagem',
    );
  });

  it('also breaks a swap: each robot wants the cell the other stands on', () => {
    const { w, f } = scene(4, { stepAside: false, watchdogSeconds: PERIOD });
    swapPlaces(f);
    const r = run(w, 40, [1, 2]);
    expect(r.arrived.size).toBe(2);
    expect(Math.max(...r.wait.values())).toBeLessThanOrEqual(PERIOD + 1);
    expect(r.minDistance).toBeGreaterThanOrEqual(SAFE_DISTANCE);
  });

  it('with step-aside requests working, only one robot of the pair steps aside', () => {
    const { w, f } = scene(4, { stepAside: true, watchdogSeconds: 0 });
    faceToFace(f, -6);
    const r = run(w, 40, [0, 1]);
    expect(r.crossed.size).toBe(2);
    expect(f.stats.evades).toBe(1);
  });
});

describe('Watchdog: robot broken inside a narrow corridor', () => {
  const REPAIR = 60;

  function broken(z: (typeof SINGLE_ENTRANCE_GATES)[number], watchdogSeconds: number) {
    const { w, f } = scene(6, { watchdogSeconds });
    brokenGate(f, z, REPAIR);
    return { f, r: run(w, 120, [1, 2, 3]) };
  }

  it.each(SINGLE_ENTRANCE_GATES)(
    'gate z=%i: the others are rerouted in seconds; the one shut in waits only for the repair',
    (z) => {
      const { f, r } = broken(z, PERIOD);
      const shutIn = r.wait.get(1)!;
      const rerouted = Math.max(r.wait.get(2)!, r.wait.get(3)!);
      // Nothing can move the broken robot: the wait is bounded by its repair.
      expect(shutIn).toBeGreaterThan(REPAIR - 2);
      expect(shutIn).toBeLessThanOrEqual(REPAIR + 1);
      expect(rerouted).toBeLessThanOrEqual(PERIOD + 2);
      expect(f.stats.reroutes).toBe(2);
      // Every route here runs through the broken robot: asking anyone to step
      // aside would only send robots back and forth.
      expect(f.stats.evades).toBe(0);
      expect(f.robots[2]!.delivered + f.robots[3]!.delivered).toBe(5);
      expect(r.crossed.has(1)).toBe(true);
      expect(r.minDistance).toBeGreaterThanOrEqual(SAFE_DISTANCE);
      expect(r.braking).toBe(0);
      console.info(
        `defeito no portão z=${z}: preso esperou ${shutIn.toFixed(0)} s (conserto em ${REPAIR} s); ` +
          `com outra baia, ${rerouted.toFixed(0)} s`,
      );
    },
    60_000,
  );

  it('reports the robot shut in as stuck after 20 s, and again when it moves', () => {
    const { w, f } = scene(6, { watchdogSeconds: PERIOD });
    brokenGate(f, -6, REPAIR);
    run(w, 120, [1]);
    const texts = w.events.filter((e) => e.kind.startsWith('robot-')).map((e) => e.text);
    const stuck = w.events.find((e) => e.kind === 'robot-stuck');
    expect(texts).toEqual(['Robô 2 sem caminho há 20 s', 'Robô 2 voltou a andar após 60 s']);
    expect(stuck!.time).toBeGreaterThanOrEqual(20);
    expect(stuck!.time).toBeLessThanOrEqual(22);
    // Robots with another drop never get there.
    expect(w.events.filter((e) => e.kind === 'robot-stuck')).toHaveLength(1);
  }, 60_000);

  it('without the watchdog everyone waits for the repair', () => {
    const { f, r } = broken(-6, 0);
    for (const id of [1, 2, 3]) expect(r.wait.get(id)).toBeGreaterThan(REPAIR - 2);
    expect(f.stats.reroutes).toBe(0);
  }, 60_000);

  it('a gate with a twin next to it costs nobody a wait: the planner goes around', () => {
    const { w, f, cell } = scene(4, { watchdogSeconds: PERIOD });
    f.place(0, cell(8, -3), 1);
    f.setDefect(0, REPAIR);
    f.place(1, cell(8, -6), 1);
    f.sendTo(1, cell(9, 1));
    f.place(2, cell(8, 0), 3);
    f.sendTo(2, cell(9, -6));
    const r = run(w, 30, [1, 2]);
    expect(Math.max(...r.wait.values())).toBe(0);
    expect(r.arrived.size).toBe(2);
  });
});
