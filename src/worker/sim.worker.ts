import { SimHost } from './host';
import type { SimCommand, SimMessage } from './protocol';

/**
 * The simulation thread. The page only sends commands and receives
 * snapshots, so a heavy step (planning 40 robots, fast-forwarding) never
 * freezes the interface.
 */
// Typed by hand: pulling in the WebWorker lib would clash with the DOM lib of the page code.
const scope = self as unknown as {
  postMessage(msg: SimMessage, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<SimCommand>) => void) | null;
};

const host = new SimHost(
  (msg: SimMessage, transfer: Transferable[]) => scope.postMessage(msg, transfer),
  () => performance.now(),
);

scope.onmessage = (e: MessageEvent<SimCommand>) => {
  try {
    host.handle(e.data);
  } catch (err) {
    scope.postMessage({ type: 'error', message: String(err) } satisfies SimMessage);
  }
};

const loop = () => {
  try {
    host.pump();
  } catch (err) {
    scope.postMessage({ type: 'error', message: String(err) } satisfies SimMessage);
  }
  setTimeout(loop, 4);
};
loop();
