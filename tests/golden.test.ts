import { describe, expect, it } from 'vitest';
import { fingerprint } from '../src/sim/fingerprint';
import { applyInput, type SimInput } from '../src/sim/recorder';
import { World, type SimConfig } from '../src/sim/world';

const SECOND = 60;

/** Runs a world with inputs at whole seconds and returns its fingerprint at the end. */
function printAfter(
  config: Partial<SimConfig>,
  seconds: number,
  inputs: { at: number; input: SimInput }[] = [],
): string {
  const w = new World(config);
  for (let t = 0; t < seconds * SECOND; t++) {
    for (const i of inputs) if (i.at * SECOND === w.tick) applyInput(w, i.input);
    w.step();
  }
  return fingerprint(w);
}

/**
 * Reference fingerprints, taken on the engine of the end of phase 4 (main at
 * bdd0193). Everything added later that is off by default (the maintenance
 * scheduler of phase 4b, ...) must leave them as they are: the published
 * numbers of the earlier phases stay reproducible. A change that alters them
 * on purpose updates them here, in the same commit, saying why.
 */
describe('reference runs', () => {
  it('default world, 2 minutes', () => {
    expect(printAfter({ seed: 7 }, 120)).toBe('e212b688');
  });

  it('heuristic routing with automatic failures, 4 minutes', () => {
    expect(
      printAfter({ seed: 20001 }, 240, [
        { at: 0, input: { type: 'policy', policy: 'heuristic' } },
        { at: 0, input: { type: 'auto', on: true } },
      ]),
    ).toBe('35b13e58');
  }, 30_000);

  it('wear, surge and a blocked dock under the heuristic, 3 minutes', () => {
    expect(
      printAfter({ seed: 30011, rackOrderRate: 0.6 }, 180, [
        { at: 0, input: { type: 'policy', policy: 'heuristic' } },
        { at: 5, input: { type: 'wear', target: 8 } },
        { at: 30, input: { type: 'inject', kind: 'surge' } },
        { at: 60, input: { type: 'inject', kind: 'dock', target: 2 } },
      ]),
    ).toBe('7f3cbe67');
  }, 30_000);

  it('no robots, automatic failures, 5 minutes', () => {
    expect(
      printAfter({ seed: 3, robots: 0 }, 300, [{ at: 0, input: { type: 'auto', on: true } }]),
    ).toBe('9ac453f2');
  });
});
