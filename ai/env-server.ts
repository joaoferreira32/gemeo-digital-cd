/**
 * The routing environment served to the Python trainer: the same TypeScript
 * engine as the app, headless, one process per environment.
 *
 *   node --import tsx ai/env-server.ts
 *
 * Messages on stdin, answers on stdout, little endian. A message is
 * `op (u8) · length (u32) · payload`; an answer is `length (u32) · payload`.
 *
 *   1 RESET   payload: JSON {seed, scenario, seconds?, reward?} → f32[obs]
 *   2 STEP    payload: u8[decisions] levels (0 … 4)         → f32 reward · u8 done · f32[obs]
 *   3 INFO    no payload                                    → JSON sizes, levels, scenarios, labels
 *   4 RESULT  no payload                                    → JSON measures of the episode + fingerprint
 *   5 CLOSE   no payload                                    → (no answer; the process exits)
 */
import { ACTION_LEVELS, DEFAULT_REWARD, RoutingEnv, type RewardWeights } from '../src/ai/env';
import { SCENARIOS, type ScenarioName } from '../src/ai/evaluate';
import { TRAINING_SEEDS } from '../src/ai/seeds';
import { fingerprint } from '../src/sim/fingerprint';

export const OP = { RESET: 1, STEP: 2, INFO: 3, RESULT: 4, CLOSE: 5 } as const;

let env = new RoutingEnv();
let weights = JSON.stringify(DEFAULT_REWARD);

function answer(payload: Uint8Array): void {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([head, payload]));
}

function json(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function floats(values: Float32Array, prefix: Buffer = Buffer.alloc(0)): Uint8Array {
  return Buffer.concat([prefix, Buffer.from(values.buffer, values.byteOffset, values.byteLength)]);
}

function handle(op: number, payload: Buffer): boolean {
  switch (op) {
    case OP.RESET: {
      const { seed, scenario, seconds, reward } = JSON.parse(payload.toString('utf8')) as {
        seed: number;
        scenario: ScenarioName;
        seconds?: number;
        reward?: RewardWeights;
      };
      // A tuning round may change the reward weights; the engine stays the same.
      const asked = JSON.stringify(reward ?? DEFAULT_REWARD);
      if (asked !== weights) {
        env = new RoutingEnv(reward ?? DEFAULT_REWARD);
        weights = asked;
      }
      answer(floats(env.reset(seed, scenario, seconds)));
      return true;
    }
    case OP.STEP: {
      const r = env.step(payload);
      const head = Buffer.alloc(5);
      head.writeFloatLE(r.reward, 0);
      head.writeUInt8(r.done ? 1 : 0, 4);
      answer(floats(r.observation, head));
      return true;
    }
    case OP.INFO:
      answer(
        json({
          observationSize: env.observationSize,
          decisions: env.decisions,
          levels: ACTION_LEVELS,
          scenarios: SCENARIOS,
          trainingSeeds: TRAINING_SEEDS,
          reward: DEFAULT_REWARD,
        }),
      );
      return true;
    case OP.RESULT:
      answer(json({ ...env.result(), fingerprint: fingerprint(env.world) }));
      return true;
    case OP.CLOSE:
      return false;
    default:
      throw new Error(`unknown op ${op}`);
  }
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 5) {
    const len = buf.readUInt32LE(1);
    if (buf.length < 5 + len) break;
    const op = buf.readUInt8(0);
    const payload = buf.subarray(5, 5 + len);
    buf = buf.subarray(5 + len);
    if (!handle(op, payload)) process.exit(0);
  }
});
process.stdin.on('end', () => process.exit(0));
