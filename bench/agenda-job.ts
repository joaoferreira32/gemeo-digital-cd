/**
 * One process of `bench/agenda.ts`: runs the automatic failures on one seed,
 * with or without the maintenance schedule, and prints the recorded run
 * (src/ai/schedule-eval.ts) as one JSON line.
 */
import { recordScheduleRun, type ScheduleRunOptions } from '../src/ai/schedule-eval';

const { seed, ...options } = JSON.parse(process.argv[2] ?? '{}') as {
  seed: number;
} & ScheduleRunOptions;
process.stdout.write(`${JSON.stringify(recordScheduleRun(seed, options))}\n`);
