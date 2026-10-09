/**
 * Memory of the worker side of the demo, run again and again as the page
 * does: the demo with AI, the jump back, the run without AI, the card, and
 * back to the app (init). The heap after a forced GC, before the first demo
 * and after each one: a recording kept by mistake would add more than 1 MB per
 * demo (a simulated hour takes about 15 MB).
 *
 *   npm run bench:demo-memoria [-- <demos>]       (default 15)
 *
 * The page side (GPU resources and the page's heap) is scripts/demo_memoria.py.
 */
import { DEMO } from '../src/demo/run';
import { SimHost } from '../src/worker/host';
import type { SimMessage } from '../src/worker/protocol';

const demos = Number(process.argv[2] ?? 15);
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('rode com --expose-gc (npm run bench:demo-memoria)');

let now = 0;
// The last demo message the page would get (in an object: it changes inside the callback).
const seen: { last: Extract<SimMessage, { type: 'demo' }> | null } = { last: null };
const phase = () => seen.last?.phase;
const host = new SimHost(
  (m) => {
    if (m.type === 'demo') seen.last = m;
  },
  () => now,
);
const pump = (times: number) => {
  for (let i = 0; i < times; i++) {
    now += 50;
    host.pump();
  }
};
// The app as leaveDemo starts it again, running live for a while.
const app = () => {
  host.handle({ type: 'init', config: { scheduleMaintenance: true } });
  host.handle({ type: 'speed', speed: 8 });
  pump(200);
};
const heap = () => {
  for (let i = 0; i < 4; i++) gc();
  return process.memoryUsage().heapUsed / 1e6;
};
const mb = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;

app();
console.log(`antes da 1ª demo: ${mb(heap())}`);
const after: number[] = [];
for (let d = 1; d <= demos; d++) {
  host.handle({ type: 'demo', action: 'start' });
  host.handle({ type: 'speed', speed: 64 });
  for (let i = 0; i < 40_000 && phase() === 'ai'; i++) pump(1);
  host.handle({ type: 'seek', time: DEMO.branchAt });
  pump(1);
  host.handle({ type: 'demo', action: 'compare' });
  for (let i = 0; i < 40_000 && phase() === 'no-ai'; i++) pump(1);
  if (phase() !== 'done') throw new Error(`a demo ${d} parou em ${phase()}`);
  app();
  after.push(heap());
  console.log(`depois da demo ${d}: ${mb(after.at(-1) as number)}`);
}
const first = after[0] as number;
const end = after.at(-1) as number;
console.log(
  `da 1ª à ${demos}ª demo: ${(end - first).toLocaleString('pt-BR', { maximumFractionDigits: 2, signDisplay: 'always' })} MB ` +
    `(${((end - first) / Math.max(1, demos - 1)).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} MB por demo)`,
);
