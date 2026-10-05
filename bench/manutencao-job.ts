/**
 * One process of `bench/manutencao.ts`: runs the automatic failures on one
 * seed and prints the recorded run (src/ai/maintenance.ts) as one JSON line.
 */
import { recordMaintenance } from '../src/ai/maintenance';
import type { DetectorParams } from '../src/sim/health';

const { seed, seconds, detector } = JSON.parse(process.argv[2] ?? '{}') as {
  seed: number;
  seconds: number;
  detector?: Partial<DetectorParams>;
};
process.stdout.write(`${JSON.stringify(recordMaintenance(seed, seconds, detector))}\n`);
