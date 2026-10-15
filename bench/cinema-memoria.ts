/**
 * Memory of the worker side of the cinema demo: a side of the split screen
 * played through every frame of the feed cut, as the page asks for them,
 * again and again on the same host (the page starts a new worker for each
 * side and ends it after, so this is the harder case), with the app run
 * between. The heap after a forced GC before the first run, at the end of
 * each run (the recording of one side: 320 simulated seconds) and after each,
 * back in the app.
 *
 *   npm run bench:cinema-memoria [-- <runs> [feed|galpao|galpao-completa]]   (default 8, feed)
 *
 * The tour's formats start where their rewind lands and keep, on the AI side,
 * the moments the rewind plays back (a snapshot each, until the rewind ends):
 * how many bytes they add up to, the heap when they are all kept (the end of
 * the teaser) and that they go.
 *
 * The page side (its two scenes on the GPU, the page's heap) is scripts/cinema_memoria.py.
 */
import {
  CINEMA_FORMATS,
  formatFrames,
  momentAt,
  rewindMoments,
  type CinemaFormatId,
} from '../src/demo/cinema';
import { SimHost } from '../src/worker/host';
import type { SimMessage } from '../src/worker/protocol';

const runs = Number(process.argv[2] ?? 8);
const format = CINEMA_FORMATS[(process.argv[3] ?? 'feed') as CinemaFormatId];
if (!format) throw new Error(`formato desconhecido: ${process.argv[3]}`);
const keep = rewindMoments(format);
// Where the runs start: the earliest moment the format shows (its rewind's landing).
const warmup = keep.length
  ? Math.min(...format.segments.flatMap((g) => g.spans.flatMap((x) => [x.from, x.to])))
  : undefined;
/** Bytes of the snapshots a rewind played back (each kept as the run went forward). */
let keptBytes = 0;
let rewinding = false;
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('rode com --expose-gc (npm run bench:cinema-memoria)');

let now = 0;
const host = new SimHost(
  (m: SimMessage) => {
    // The page hands every snapshot back once drawn.
    if (m.type !== 'cinema') return;
    if (rewinding) keptBytes += m.buffer.byteLength;
    host.handle({ type: 'release', buffer: m.buffer });
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
  const side = r % 2 ? 'ai' : 'no-ai';
  host.handle({
    type: 'cinema',
    action: 'start',
    side,
    ...(warmup === undefined ? {} : { warmup }),
    ...(side === 'ai' && keep.length ? { keep } : {}),
  });
  let asked = NaN;
  let full = NaN;
  keptBytes = 0;
  for (let k = 0; k < formatFrames(format); k++) {
    const m = momentAt(format, k);
    // A rewind plays back the AI side's kept moments; the other side is not asked then.
    if (m.speed < 0 && side === 'no-ai') continue;
    if (m.time === asked) continue;
    // All the rewind's moments kept: the heap then (once per run).
    if (m.speed < 0 && Number.isNaN(full)) full = heap();
    rewinding = m.speed < 0;
    asked = m.time;
    host.handle({ type: 'cinema', action: 'to', time: m.time, frame: k, measure: false });
  }
  rewinding = false;
  const during = heap();
  const rec = host.currentRecorder;
  host.handle({ type: 'cinema', action: 'stop' });
  app();
  after.push(heap());
  const kept = Number.isNaN(full)
    ? ''
    : `; com a rebobinada guardada ${mb(full)} (${keptBytes ? mb(keptBytes / 1e6) : 'nada'} em quadros)`;
  console.log(
    `execução ${r} (${side}): no fim ${mb(during)} (gravação de um lado: ${mb(rec.memoryBytes / 1e6)})${kept}; de volta ao app ${mb(after.at(-1) as number)}`,
  );
}
const first = after[0] as number;
const end = after.at(-1) as number;
console.log(
  `da 1ª à ${runs}ª execução: ${(end - first).toLocaleString('pt-BR', { maximumFractionDigits: 2, signDisplay: 'always' })} MB ` +
    `(${((end - first) / Math.max(1, runs - 1)).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} MB por execução)`,
);
