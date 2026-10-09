import type { Agent } from '../ai/agent';
import { loadAgent } from '../worker/routing';
import type { LabReply, LabRequest } from './pool';
import { runLab } from './run';

/**
 * One worker of the scenario lab: runs the jobs it gets, one at a time. The
 * routing network (trained policy) is loaded the first time a job needs it
 * and kept for the next ones.
 */
// Typed by hand: pulling in the WebWorker lib would clash with the DOM lib of the page code.
const scope = self as unknown as {
  postMessage(msg: LabReply): void;
  onmessage: ((e: MessageEvent<LabRequest>) => void) | null;
};

let agent: Promise<Agent> | null = null;
let agentUrl = '';

scope.onmessage = (e: MessageEvent<LabRequest>) => {
  const r = e.data;
  void (async () => {
    try {
      let a: Agent | undefined;
      if (r.scenario.policy === 'rl') {
        if (!agent || agentUrl !== r.modelUrl) {
          agentUrl = r.modelUrl ?? '';
          agent = loadAgent(agentUrl);
        }
        a = await agent;
      }
      const metrics = await runLab(r.scenario, r.seed, {
        seconds: r.seconds,
        ...(r.weights ? { weights: r.weights } : {}),
        ...(r.startHour !== undefined ? { startHour: r.startHour } : {}),
        ...(a ? { agent: a } : {}),
      });
      scope.postMessage({ id: r.id, metrics });
    } catch (err) {
      scope.postMessage({ id: r.id, error: err instanceof Error ? err.message : String(err) });
    }
  })();
};
