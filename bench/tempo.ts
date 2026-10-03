/**
 * Time travel, measured on one simulated hour (40 robots, automatic failures):
 *
 *  - memory kept by the recorder per hour (checkpoints, logs, samples), with
 *    the growth of the JS heap plus array buffers as a cross-check (GC exposed);
 *  - cost of taking a checkpoint;
 *  - latency of a seek to random moments (last checkpoint + replay) against a
 *    replay from tick 0 to the same moment.
 *
 *   npm run bench:tempo            (about 3 minutes)
 */
import { performance } from 'node:perf_hooks';
import { Recorder } from '../src/sim/recorder';
import { Rng } from '../src/sim/rng';
import { World } from '../src/sim/world';

const HOUR = 3600;
const CONFIG = { seed: 2026 };
const gc = (globalThis as { gc?: () => void }).gc;

const quantile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] as number;
};
const round = (x: number, d = 1) => Number(x.toFixed(d));

gc?.();
const used = () => {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};
const heapBefore = used();
const rec = new Recorder(CONFIG);
rec.input({ type: 'auto', on: true });
const saveMs: number[] = [];
const ticksPerHour = Math.round(HOUR / rec.config.dt);
const t0 = performance.now();
for (let i = 0; i < ticksPerHour; i++) {
  const before = rec.checkpoints.length;
  const t = performance.now();
  rec.step();
  if (rec.checkpoints.length > before) saveMs.push(performance.now() - t);
}
const recordSeconds = (performance.now() - t0) / 1000;
gc?.();
const heapAfter = used();

const sizes = rec.checkpoints.map((c) => c.state.ints.byteLength + c.state.floats.byteLength);
const checkpointBytes = sizes.reduce((a, b) => a + b, 0);

// Seeks to random moments, each from the live head (a restore every time).
const rng = new Rng(9);
const seekMs: number[] = [];
for (let i = 0; i < 60; i++) {
  const target = rng.int(rec.headTick);
  rec.backToLive();
  const t = performance.now();
  rec.seek(target);
  seekMs.push(performance.now() - t);
}
rec.backToLive();

// Replay from tick 0 to the end of the hour (what a seek would cost without checkpoints).
const fromZero = (seconds: number) => {
  const t = performance.now();
  const w = new World(rec.config);
  w.failures.setAuto(true, 0);
  w.stepMany(Math.round(seconds / rec.config.dt));
  return (performance.now() - t) / 1000;
};
const fromZeroHalf = fromZero(HOUR / 2);
const fromZeroHour = fromZero(HOUR);

console.log(
  JSON.stringify(
    {
      simulatedSeconds: HOUR,
      robots: rec.live.fleet?.robots.length ?? 0,
      recordingWallSeconds: round(recordSeconds),
      checkpoints: {
        every: rec.every * rec.config.dt,
        count: rec.checkpoints.length,
        kbMean: round(checkpointBytes / sizes.length / 1024),
        kbMax: round(Math.max(...sizes) / 1024),
        saveMsMedian: round(quantile(saveMs, 0.5), 2),
        saveMsMax: round(Math.max(...saveMs), 2),
      },
      memoryPerHourMB: {
        recorder: round(rec.memoryBytes / 2 ** 20),
        checkpoints: round(checkpointBytes / 2 ** 20),
        heapAndBuffersGrowth: gc ? round((heapAfter - heapBefore) / 2 ** 20) : null,
      },
      events: rec.events.length,
      stageChanges: rec.journal.length,
      seek: {
        samples: seekMs.length,
        msMedian: round(quantile(seekMs, 0.5)),
        msP95: round(quantile(seekMs, 0.95)),
        msMax: round(Math.max(...seekMs)),
      },
      replayFromZeroSeconds: { halfHour: round(fromZeroHalf), hour: round(fromZeroHour) },
      speedupAtEndOfHour: Math.round((fromZeroHour * 1000) / quantile(seekMs, 0.5)),
    },
    null,
    2,
  ),
);
