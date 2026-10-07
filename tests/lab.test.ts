import { describe, expect, it } from 'vitest';
import { Episode } from '../src/ai/evaluate';
import { LabPool, type LabReply, type LabRequest, type WorkerLike } from '../src/lab/pool';
import {
  DEFAULT_SCENARIO,
  labWorld,
  runLab,
  type LabMetrics,
  type LabScenario,
} from '../src/lab/run';
import { estimate, pairedDifference } from '../src/lab/stats';
import { fingerprint } from '../src/sim/fingerprint';

const SECOND = 60;
/** The evaluation scenarios of phase 4 run without the maintenance schedule. */
const EVALUATION: LabScenario = { ...DEFAULT_SCENARIO, maintenance: false };

describe('lab runs', () => {
  for (const [name, scenario, autoFailures] of [
    ['normal', EVALUATION, false],
    ['caos', { ...EVALUATION, autoFailures: true }, true],
  ] as const) {
    it(`a lab scenario equal to the evaluation scenario "${name}" is that evaluation, bit for bit`, async () => {
      const episode = new Episode(41, name, 'heuristic', { seconds: 300 });
      episode.run(Infinity);
      const world = labWorld(scenario, 41);
      world.stepMany(300 * SECOND);
      expect(fingerprint(world)).toBe(fingerprint(episode.world));
      const lab = await runLab(scenario, 41, { seconds: 300 });
      const evaluation = episode.result();
      expect(lab.delivered).toBe(evaluation.delivered);
      expect(lab.cycleP95).toBe(evaluation.cycleP95);
      expect(lab.cycleMean).toBeCloseTo(evaluation.cycleMean, 9);
      expect(autoFailures).toBe(scenario.autoFailures);
    }, 30_000);
  }

  it('a belt stopped for the whole run stays stopped, and nothing leaves it', () => {
    const world = labWorld({ ...DEFAULT_SCENARIO, brokenConveyor: 2 }, 5);
    world.stepMany(120 * SECOND);
    expect(world.conveyors[2]!.status).toBe('broken');
    expect(world.conveyorExits[2]).toBe(0);
  });

  it('measures what it compares: flow, cycle and the use of belts, docks and robots', async () => {
    const m = await runLab(DEFAULT_SCENARIO, 7, { seconds: 240 });
    expect(m.delivered).toBeGreaterThan(100);
    expect(m.throughput).toBeCloseTo((m.delivered / 180) * 60, 9);
    expect(m.cycleP95).toBeGreaterThan(m.cycleMean);
    for (const use of [m.beltUse, m.dockUse, m.robotUse]) {
      expect(use).toBeGreaterThan(0);
      expect(use).toBeLessThanOrEqual(1);
    }
    const noRobots = await runLab({ ...DEFAULT_SCENARIO, robots: 0 }, 7, { seconds: 120 });
    expect(noRobots.robotUse).toBeNaN();
  }, 30_000);

  it('asks for what it needs: the profile for the Olist demand, the network for the trained policy', async () => {
    await expect(
      runLab({ ...DEFAULT_SCENARIO, demand: 'olist' }, 1, { seconds: 10 }),
    ).rejects.toThrow(/perfil/);
    await expect(runLab({ ...DEFAULT_SCENARIO, policy: 'rl' }, 1, { seconds: 10 })).rejects.toThrow(
      /rede/,
    );
  });
});

describe('lab statistics', () => {
  it('a mean with its 95% interval (Student t)', () => {
    const e = estimate([1, 2, 3]);
    expect(e.mean).toBe(2);
    // t(2) = 4.303, standard error 1/√3.
    expect(e.high - e.mean).toBeCloseTo(4.303 / Math.sqrt(3), 6);
    expect(estimate([5]).high).toBe(Infinity);
    expect(estimate([1, NaN, 3]).n).toBe(2);
  });

  it('the paired difference B − A seed by seed, and how many seeds go each way', () => {
    const d = pairedDifference([10, 20, 30, 40], [9, 22, 27, 40]);
    expect(d.mean).toBeCloseTo((-1 + 2 - 3 + 0) / 4, 12);
    expect([d.lower, d.higher]).toEqual([2, 1]);
    expect(() => pairedDifference([1], [1, 2])).toThrow();
  });
});

/** A stand-in for a Web Worker: runs `job` after `delay` ms, in this thread. */
class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: LabReply }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;

  constructor(
    private readonly job: (r: LabRequest) => Promise<LabMetrics>,
    private readonly delay: (r: LabRequest) => number,
    private readonly crashOn?: (r: LabRequest) => boolean,
  ) {}

  postMessage(r: LabRequest): void {
    setTimeout(() => {
      if (this.terminated) return;
      if (this.crashOn?.(r)) {
        this.onerror?.({ message: 'o worker caiu' });
        return;
      }
      this.job(r).then(
        (metrics) => {
          if (!this.terminated) this.onmessage?.({ data: { id: r.id, metrics } });
        },
        (err: unknown) => {
          if (!this.terminated) this.onmessage?.({ data: { id: r.id, error: String(err) } });
        },
      );
    }, this.delay(r));
  }

  terminate(): void {
    this.terminated = true;
  }
}

const fakeMetrics = (seed: number): LabMetrics => ({
  delivered: seed,
  throughput: seed / 2,
  cycleMean: seed / 3,
  cycleP95: seed / 4,
  beltUse: 0.5,
  dockUse: 0.5,
  robotUse: 0.5,
});

const requests = (seeds: number[]) =>
  seeds.map((seed) => ({ scenario: DEFAULT_SCENARIO, seed, seconds: 10 }));

describe('lab pool', () => {
  it('gives the results in the order of the jobs, whatever the number of workers', async () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7];
    // Later jobs finish first: the order of arrival is the reverse of the order of the jobs.
    const delay = (r: LabRequest) => 30 - r.seed * 3;
    const job = (r: LabRequest) => Promise.resolve(fakeMetrics(r.seed));
    for (const size of [1, 3, 8]) {
      const progress: number[] = [];
      const pool = new LabPool(size, () => new FakeWorker(job, delay));
      const out = await pool.run(requests(seeds), (done) => progress.push(done));
      expect(out.map((o) => ('metrics' in o ? o.metrics.delivered : -1))).toEqual(seeds);
      expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7]);
      pool.dispose();
    }
  });

  it('runs the simulation the same with one worker or three', async () => {
    const job = (r: LabRequest) => runLab(r.scenario, r.seed, { seconds: r.seconds });
    const jobs = [11, 12, 13, 14].map((seed) => ({
      scenario: DEFAULT_SCENARIO,
      seed,
      seconds: 40,
    }));
    const one = await new LabPool(1, () => new FakeWorker(job, () => 0)).run(jobs);
    const three = await new LabPool(3, () => new FakeWorker(job, (r) => (r.seed % 3) * 5)).run(
      jobs,
    );
    expect(three).toEqual(one);
  }, 60_000);

  it('a job that fails gives its error and the others go on; a crashed worker is replaced', async () => {
    let spawned = 0;
    const job = (r: LabRequest) =>
      r.seed === 3
        ? Promise.reject(new Error('cenário inválido'))
        : Promise.resolve(fakeMetrics(r.seed));
    const pool = new LabPool(2, () => {
      spawned++;
      return new FakeWorker(
        job,
        () => 1,
        (r) => r.seed === 2,
      );
    });
    const out = await pool.run(requests([1, 2, 3, 4, 5, 6]));
    expect(out[2]).toEqual({ error: 'Error: cenário inválido' });
    // The second worker crashed on its first job, with work left: a third one took its place.
    expect(out[1]).toEqual({ error: 'o worker caiu' });
    expect(out.filter((o) => 'metrics' in o)).toHaveLength(4);
    expect(spawned).toBe(3);
  });

  it('cancel stops the runs: the promise is rejected and the workers are terminated', async () => {
    const workers: FakeWorker[] = [];
    const pool = new LabPool(2, () => {
      const w = new FakeWorker(
        (r) => Promise.resolve(fakeMetrics(r.seed)),
        () => 50,
      );
      workers.push(w);
      return w;
    });
    const pending = pool.run(requests([1, 2, 3, 4]));
    pool.cancel();
    await expect(pending).rejects.toThrow('cancelado');
    expect(workers.every((w) => w.terminated)).toBe(true);
    // The pool still works afterwards, with new workers.
    const again = await pool.run(requests([9]));
    expect(again).toEqual([{ metrics: fakeMetrics(9) }]);
  });
});
