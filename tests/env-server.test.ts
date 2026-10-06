import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { RoutingEnv } from '../src/ai/env';
import { fingerprint } from '../src/sim/fingerprint';

/** Minimal client of ai/env-server.ts, speaking the same binary framing as the Python trainer. */
class Client {
  private buf = Buffer.alloc(0);
  private waiting: ((b: Buffer) => void) | null = null;

  constructor(private readonly proc: ChildProcessWithoutNullStreams) {
    proc.stdout.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.flush();
    });
  }

  private flush(): void {
    if (!this.waiting || this.buf.length < 4) return;
    const len = this.buf.readUInt32LE(0);
    if (this.buf.length < 4 + len) return;
    const payload = this.buf.subarray(4, 4 + len);
    this.buf = this.buf.subarray(4 + len);
    const resolve = this.waiting;
    this.waiting = null;
    resolve(Buffer.from(payload));
  }

  /** Ends the server (it exits without an answer). */
  close(): void {
    const head = Buffer.alloc(5);
    head.writeUInt8(5, 0);
    this.proc.stdin.write(head);
  }

  send(op: number, payload: Uint8Array = new Uint8Array(0)): Promise<Buffer> {
    const head = Buffer.alloc(5);
    head.writeUInt8(op, 0);
    head.writeUInt32LE(payload.length, 1);
    const p = new Promise<Buffer>((resolve) => {
      this.waiting = resolve;
      this.flush();
    });
    this.proc.stdin.write(Buffer.concat([head, Buffer.from(payload)]));
    return p;
  }
}

const levelsAt = (t: number) => [t % 5, (t * 3) % 5, 4, (t * 7) % 5, (t >> 2) % 5];

describe('Training environment server', () => {
  it('runs an episode through the binary protocol exactly like the engine does directly', async () => {
    const proc = spawn(process.execPath, ['--import', 'tsx', 'ai/env-server.ts']);
    const client = new Client(proc);
    try {
      const info = JSON.parse((await client.send(3)).toString('utf8'));
      expect(info.decisions).toBe(5);
      expect(info.levels).toBe(5);

      const reset = await client.send(
        1,
        Buffer.from(JSON.stringify({ seed: 10_123, scenario: 'esteira', seconds: 150 })),
      );
      expect(reset.length).toBe(info.observationSize * 4);
      let rewards = 0;
      let steps = 0;
      for (let t = 0; ; t++) {
        const r = await client.send(2, Uint8Array.from(levelsAt(t)));
        rewards += r.readFloatLE(0);
        steps++;
        if (r.readUInt8(4) === 1) break;
      }
      const remote = JSON.parse((await client.send(4)).toString('utf8'));

      // The same actions, straight on the engine.
      const env = new RoutingEnv();
      env.reset(10_123, 'esteira', 150);
      let direct = 0;
      for (let t = 0; ; t++) {
        const r = env.step(levelsAt(t));
        direct += Math.fround(r.reward);
        if (r.done) break;
      }
      expect(steps).toBe(150);
      const { fingerprint: remotePrint, ...measures } = remote;
      expect(remotePrint).toBe(fingerprint(env.world));
      expect(measures).toEqual(JSON.parse(JSON.stringify(env.result())));
      expect(rewards).toBeCloseTo(direct, 3);
    } finally {
      client.close();
      proc.kill();
    }
  }, 60_000);
});
