/**
 * Builds the headless entry points (training environment server, routing
 * benchmark jobs) into build/headless/ with esbuild.
 *
 *   node scripts/build-headless.mjs
 *
 * Why not run them with tsx: tsx compiles with esbuild's keepNames, which
 * wraps every function created at run time in a helper that sets its name.
 * The motion code creates small functions in its inner loops, and under tsx
 * that helper took about 75% of an episode (11 s instead of 1.9 s, measured).
 * The app is bundled by Vite without keepNames, so this build is also closer
 * to what runs in the browser. Same sources, same results bit for bit (the
 * Python fidelity test compares this build with the sources run by tsx).
 * Callers build right before running, so a stale build is never used.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['ai/env-server.ts', 'bench/rotas-job.ts'],
  outdir: 'build/headless',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
});
