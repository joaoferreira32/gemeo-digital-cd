/**
 * One process of `bench/lab.ts`: one lab scenario on one seed (src/lab/run.ts),
 * printed as one JSON line.
 */
import { runLab, type LabScenario } from '../src/lab/run';

const { scenario, seed, seconds, weights, startHour } = JSON.parse(process.argv[2] ?? '{}') as {
  scenario: LabScenario;
  seed: number;
  seconds: number;
  weights?: number[];
  startHour?: number;
};
const metrics = await runLab(scenario, seed, {
  seconds,
  ...(weights ? { weights } : {}),
  ...(startHour !== undefined ? { startHour } : {}),
});
process.stdout.write(`${JSON.stringify({ seed, metrics })}\n`);
