import type * as Ort from 'onnxruntime-web';

/**
 * The trained routing agent (ai/train.py) as the app and the benchmark run
 * it: the exported network gives, for each routing choice, one score per
 * level, and the agent takes the best level of each choice (the policy's
 * most likely action, no sampling). Inference runs on onnxruntime-web, in
 * the browser worker and in Node alike.
 */
export interface AgentInfo {
  readonly name: string;
  readonly observationSize: number;
  readonly decisions: number;
  readonly levels: number;
}

/** Best level of each choice from the network's scores (choice-major, `levels` per choice). */
export function levelsFromLogits(
  logits: ArrayLike<number>,
  decisions: number,
  levels: number,
): number[] {
  const out = new Array<number>(decisions);
  for (let d = 0; d < decisions; d++) {
    let best = 0;
    for (let l = 1; l < levels; l++) {
      if ((logits[d * levels + l] as number) > (logits[d * levels + best] as number)) best = l;
    }
    out[d] = best;
  }
  return out;
}

export type Agent = (observation: Float32Array) => Promise<number[]>;

/** Loads the network once; the returned function runs one observation at a time. */
export async function createAgent(
  ort: typeof Ort,
  model: Uint8Array,
  info: AgentInfo,
): Promise<Agent> {
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  return async (observation) => {
    if (observation.length !== info.observationSize) {
      throw new Error(
        `observation of ${observation.length} values, the agent expects ${info.observationSize}`,
      );
    }
    const input = new ort.Tensor('float32', observation, [1, info.observationSize]);
    const out = await session.run({ obs: input });
    return levelsFromLogits(out.logits!.data as Float32Array, info.decisions, info.levels);
  };
}
