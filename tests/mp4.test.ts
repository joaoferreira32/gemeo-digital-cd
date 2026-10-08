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
      // Durations in the run (flag 0x100): a stall in the middle (2000), not at the end.
      ...box(
        'moof',
        box('traf', box('tfhd', u32(0, 1)), box('trun', u32(0x000100, 3, 500, 2000, 500))),
      ),
      // The default duration of the fragment (tfhd flag 0x8), not the one of the track (500).
      ...box('moof', box('traf', box('tfhd', u32(0x000008, 1, 1000)), box('trun', u32(0, 2)))),
      // Audio: not counted.
      ...box(
        'moof',
        box('traf', box('tfhd', u32(0, 2)), box('trun', u32(0x000100, 2, 1024, 1024))),
      ),
    ]);
    const r = mp4Frames(file)!;
    expect(r.frames).toBe(5);
    expect(r.seconds).toBeCloseTo(5000 / 30_000, 12);
    expect(r.fps).toBeCloseTo(5 / (5000 / 30_000), 9);
    expect(r.longestGap).toBeCloseTo(2000 / 30_000, 12);
  });

  it('falls back on the default of the track when the fragment has none', () => {
    const file = new Uint8Array([
      ...box('moov', trak(1, 60, 'vide'), box('mvex', box('trex', u32(0, 1, 1, 1, 0, 0)))),
      ...box('moof', box('traf', box('tfhd', u32(0, 1)), box('trun', u32(0, 120)))),
    ]);
    expect(mp4Frames(file)).toMatchObject({ frames: 120, seconds: 2, fps: 60 });
  });

  it('skips the data offset and the other per-sample fields of a run', () => {
    // Flags 0x1 (data offset), 0x100 (duration) and 0x200 (size): each sample is two words.
    const file = new Uint8Array([
      ...box('moov', trak(1, 1000, 'vide'), box('mvex', box('trex', u32(0, 1, 1, 7, 0, 0)))),
      ...box(
        'moof',
        box(
          'traf',
          box('tfhd', u32(0, 1)),
          box('trun', u32(0x000301, 3, 64, 10, 900, 20, 800, 30, 700)),
        ),
      ),
    ]);
    expect(mp4Frames(file)).toMatchObject({ frames: 3, seconds: 0.06, longestGap: 0.03 });
  });

  it('reads the sample table of a file that is not fragmented', () => {
    // stts: 3 frames of 1000 then 1 of 2000; the audio table does not count.
    const stbl = (scale: number, handler: string, id: number, ...entries: number[]) =>
      box(
        'trak',
        box('tkhd', u32(0, 0, 0, id, 0)),
        box(
          'mdia',
          box('mdhd', u32(0, 0, 0, scale, 0)),
          box('hdlr', u32(0, 0), text(handler), u32(0, 0, 0)),
          box('minf', box('stbl', box('stts', u32(0, entries.length / 2, ...entries)))),
        ),
      );
    const file = box(
      'moov',
      stbl(44_100, 'soun', 2, 50, 1024),
      stbl(10_000, 'vide', 1, 3, 1000, 1, 2000),
    );
    expect(mp4Frames(file)).toMatchObject({ frames: 4, seconds: 0.5, fps: 8, longestGap: 0.2 });
  });

  it('nothing to count without a video track', () => {
    expect(mp4Frames(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull();
    expect(mp4Frames(box('moov', trak(2, 48_000, 'soun')))).toBeNull();
  });
});
