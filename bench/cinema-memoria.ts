/**
 * Memory of the worker side of the cinema demo: a side of the split screen
 * played through every frame of the feed cut, as the page asks for them,
 * again and again on the same host (the page starts a new worker for each
 * side and ends it after, so this is the harder case), with the app run
 * between. The heap after a forced GC before the first run, at the end of
 * each run (the recording of one side: 320 simulated seconds) and after each,
 * back in the app.
 *
 *   npm run bench:cinema-memoria [-- <runs>]       (default 8)
 *
 * The page side (its two scenes on the GPU, the page's heap) is scripts/cinema_memoria.py.
 */
import { FEED, formatFrames, momentAt } from '../src/demo/cinema';
import { SimHost } from '../src/worker/host';
import type { SimMessage } from '../src/worker/protocol';

const runs = Number(process.argv[2] ?? 8);
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('rode com --expose-gc (npm run bench:cinema-memoria)');

let now = 0;
const host = new SimHost(
  (m: SimMessage) => {
    // The page hands every snapshot back once drawn.
    if (m.type === 'cinema') host.handle({ type: 'release', buffer: m.buffer });
  },
  () => now,
);
const app = () => {
  host.handle({ type: 'init', config: { scheduleMaintenance: true } });
  host.handle({ type: 'speed', speed: 8 });
  for (let i = 0; i < 200; i++) {
    now += 50;
    host.pump();
  }
};
const heap = () => {
  for (let i = 0; i < 4; i++) gc();
  return process.memoryUsage().heapUsed / 1e6;
};
const mb = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;

app();
console.log(`antes da 1ª execução: ${mb(heap())}`);
const after: number[] = [];
for (let r = 1; r <= runs; r++) {
  host.handle({ type: 'cinema', action: 'start', side: r % 2 ? 'ai' : 'no-ai' });
  let asked = NaN;
  for (let k = 0; k < formatFrames(FEED); k++) {
    const m = momentAt(FEED, k);
    if (m.time === asked) continue;
    asked = m.time;
    host.handle({ type: 'cinema', action: 'to', time: m.time, frame: k, measure: false });
  }
  const during = heap();
  const rec = host.currentRecorder;
  host.handle({ type: 'cinema', action: 'stop' });
  app();
  after.push(heap());
  console.log(
    `execução ${r}: no fim ${mb(during)} (gravação de um lado: ${mb(rec.memoryBytes / 1e6)}); de volta ao app ${mb(after.at(-1) as number)}`,
  );
}
const first = after[0] as number;
const end = after.at(-1) as number;
console.log(
  `da 1ª à ${runs}ª execução: ${(end - first).toLocaleString('pt-BR', { maximumFractionDigits: 2, signDisplay: 'always' })} MB ` +
    `(${((end - first) / Math.max(1, runs - 1)).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} MB por execução)`,
);
