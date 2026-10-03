/**
 * Short engine benchmark (Node, no browser). Each case runs REPS times and the
 * median is reported, with every sample kept so run-to-run variation can be
 * studied. Output: JSON on stdout, or written to the path given as argument.
 *
 *   npm run bench               # prints JSON
 *   npm run bench -- out.json   # writes JSON
 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { SnapshotWriter } from '../src/sim/snapshot';
import { Recorder } from '../src/sim/recorder';
import { World } from '../src/sim/world';

const REPS = 5;

interface Gate {
  /** Relative regression (0.10 = 10 %) that triggers the gate. */
  threshold: number;
  /** true: the CI job fails (after a confirmation round); false: warning only. */
  blocking: boolean;
}

interface Case {
  name: string;
  /** Unit of the reported value; "higher" says which direction is better. */
  unit: string;
  better: 'higher' | 'lower';
  gate: Gate;
  run: () => number;
}

/**
 * Steps per second are stable on one runner (A/A runs differed by at most
 * 3.4 % over 5 CI runs), so they block above 10 %. Snapshot time is a
 * fraction of a millisecond and noisier (8.5 %): it only warns.
 */
const BLOCK: Gate = { threshold: 0.1, blocking: true };
const WARN: Gate = { threshold: 0.15, blocking: false };

function stepsPerSecond(
  config: ConstructorParameters<typeof World>[0],
  warmup: number,
  steps: number,
): number {
  const w = new World(config);
  w.stepMany(warmup);
  const t0 = performance.now();
  w.stepMany(steps);
  return steps / ((performance.now() - t0) / 1000);
}

const cases: Case[] = [
  {
    name: 'Motor sem robôs (passos/s)',
    unit: 'passos/s',
    better: 'higher',
    gate: BLOCK,
    run: () => stepsPerSecond({ seed: 1, robots: 0 }, 3600, 72_000),
  },
  {
    name: 'Motor com 40 robôs (passos/s)',
    unit: 'passos/s',
    better: 'higher',
    gate: BLOCK,
    run: () => stepsPerSecond({ seed: 1 }, 1800, 7200),
  },
  {
    // The live app runs through the recorder: checkpoints every 30 s and one
    // sample per second on top of the engine.
    name: 'Motor gravando, 40 robôs (passos/s)',
    unit: 'passos/s',
    better: 'higher',
    gate: BLOCK,
    run: () => {
      const rec = new Recorder({ seed: 1 });
      rec.stepMany(1800);
      const t0 = performance.now();
      rec.stepMany(7200);
      return 7200 / ((performance.now() - t0) / 1000);
    },
  },
  {
    name: 'Teste de carga + 40 robôs (passos/s)',
    unit: 'passos/s',
    better: 'higher',
    gate: BLOCK,
    run: () => stepsPerSecond({ seed: 1, arrivalRate: 40 }, 3600, 3600),
  },
  {
    name: 'Snapshot com 40 robôs (ms)',
    unit: 'ms',
    better: 'lower',
    gate: WARN,
    run: () => {
      const w = new World({ seed: 1, arrivalRate: 40 });
      w.stepMany(3600);
      const writer = new SnapshotWriter(w);
      const n = 200;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        w.step();
        writer.recycle(writer.write({ speed: 1, stress: true }));
      }
      return (performance.now() - t0) / n;
    },
  },
];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
};

const results = cases.map((c) => {
  c.run(); // warm-up: lets the JIT compile the hot paths, not measured
  const samples = Array.from({ length: REPS }, () => c.run());
  return {
    name: c.name,
    unit: c.unit,
    better: c.better,
    gate: c.gate,
    value: median(samples),
    samples,
  };
});

const report = { node: process.version, reps: REPS, results };
const out = process.argv[2];
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
else console.log(JSON.stringify(report, null, 2));
