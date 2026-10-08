import { describe, expect, it } from 'vitest';
import { mp4Frames } from '../src/demo/mp4';

/** An MP4 box: size, kind, then the payload. */
function box(kind: string, ...parts: Uint8Array[]): Uint8Array {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(
    [...kind].map((c) => c.charCodeAt(0)),
    4,
  );
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const u32 = (...values: number[]) => {
  const out = new Uint8Array(values.length * 4);
  values.forEach((v, i) => new DataView(out.buffer).setUint32(i * 4, v));
  return out;
};
const text = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

/** A track: its id, its timescale, its handler ("vide", "soun"). */
const trak = (id: number, scale: number, handler: string) =>
  box(
    'trak',
    box('tkhd', u32(0, 0, 0, id, 0)),
    box(
      'mdia',
      box('mdhd', u32(0, 0, 0, scale, 0)),
      box('hdlr', u32(0, 0), text(handler), u32(0, 0, 0)),
    ),
  );

describe('frames inside an MP4 (as MediaRecorder writes it, in fragments)', () => {
  it('counts the samples of the video track and adds up their durations', () => {
    const file = new Uint8Array([
      ...box(
        'moov',
        trak(1, 30_000, 'vide'),
        trak(2, 48_000, 'soun'),
        box('mvex', box('trex', u32(0, 1, 1, 500, 0, 0))),
      ),
      // Durations in the run (flag 0x100): one frame twice as long as the others.
      ...box(
        'moof',
        box('traf', box('tfhd', u32(0, 1)), box('trun', u32(0x000100, 3, 500, 500, 1000))),
      ),
      // The default duration of the fragment (tfhd flag 0x8).
      ...box('moof', box('traf', box('tfhd', u32(0x000008, 1, 500)), box('trun', u32(0, 2)))),
      // Audio: not counted.
      ...box(
        'moof',
        box('traf', box('tfhd', u32(0, 2)), box('trun', u32(0x000100, 2, 1024, 1024))),
      ),
    ]);
    const r = mp4Frames(file)!;
    expect(r.frames).toBe(5);
    expect(r.seconds).toBeCloseTo(3000 / 30_000, 12);
    expect(r.fps).toBeCloseTo(5 / 0.1, 9);
    expect(r.longestGap).toBeCloseTo(1000 / 30_000, 12);
  });

  it('falls back on the default of the track when the fragment has none', () => {
    const file = new Uint8Array([
      ...box('moov', trak(1, 60, 'vide'), box('mvex', box('trex', u32(0, 1, 1, 1, 0, 0)))),
      ...box('moof', box('traf', box('tfhd', u32(0, 1)), box('trun', u32(0, 120)))),
    ]);
    expect(mp4Frames(file)).toMatchObject({ frames: 120, seconds: 2, fps: 60 });
  });

  it('nothing to count without a video track', () => {
    expect(mp4Frames(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull();
    expect(mp4Frames(box('moov', trak(2, 48_000, 'soun')))).toBeNull();
  });
});
