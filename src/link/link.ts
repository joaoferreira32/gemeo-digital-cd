import { SimHost } from '../worker/host';
import type { SimCommand, SimMessage } from '../worker/protocol';

/**
 * Connection between the page and the simulation. The default runs the
 * simulation in a Web Worker; the inline variant runs the very same host on
 * the main thread (fallback, and the baseline of the responsiveness benchmark).
 */
export interface SimLink {
  readonly mode: 'worker' | 'inline';
  send(cmd: SimCommand, transfer?: Transferable[]): void;
  onMessage: ((msg: SimMessage) => void) | null;
  dispose(): void;
}

export function createWorkerLink(): SimLink {
  const worker = new Worker(new URL('../worker/sim.worker.ts', import.meta.url), {
    type: 'module',
    name: 'simulacao',
  });
  const link: SimLink = {
    mode: 'worker',
    onMessage: null,
    send: (cmd, transfer = []) => worker.postMessage(cmd, transfer),
    dispose: () => worker.terminate(),
  };
  worker.onmessage = (e: MessageEvent<SimMessage>) => link.onMessage?.(e.data);
  worker.onerror = (e) => link.onMessage?.({ type: 'error', message: e.message });
  return link;
}

export function createInlineLink(): SimLink {
  let timer = 0;
  let alive = true;
  const link: SimLink = {
    mode: 'inline',
    onMessage: null,
    send: (cmd) => {
      // Asynchronous like a worker, so callers behave the same with both links.
      queueMicrotask(() => alive && host.handle(cmd));
    },
    dispose: () => {
      alive = false;
      clearTimeout(timer);
    },
  };
  const host = new SimHost(
    (msg) => link.onMessage?.(msg),
    () => performance.now(),
  );
  const loop = () => {
    if (!alive) return;
    host.pump();
    timer = window.setTimeout(loop, 4);
  };
  loop();
  return link;
}

/** `?sim=main` runs the simulation on the main thread (comparison and fallback). */
export function createLink(): SimLink {
  const wantsInline = new URLSearchParams(location.search).get('sim') === 'main';
  if (!wantsInline && typeof Worker !== 'undefined') {
    try {
      return createWorkerLink();
    } catch {
      // Fall through to the inline host.
    }
  }
  return createInlineLink();
}
