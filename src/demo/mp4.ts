/**
 * The video frames inside an MP4 file (as MediaRecorder writes it, in
 * fragments or not), read from the boxes without decoding anything: how many
 * frames the file really holds and over how long. Counting frames while the
 * file plays back depends on how fast the machine decodes it at that moment
 * (the same file gave 58.7 and 42.8 frames per second), so the page reports
 * this instead.
 */

export interface Mp4Frames {
  readonly frames: number;
  readonly seconds: number;
  readonly fps: number;
  /** The longest gap between two frames (s): a stall of the encoder shows here. */
  readonly longestGap: number;
}

const CONTAINERS = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'moof',
  'traf',
  'mvex',
  'edts',
]);

/** Null when the bytes hold no video track (not an MP4, or audio only). */
export function mp4Frames(bytes: Uint8Array): Mp4Frames | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number) => view.getUint32(at);
  const kindAt = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  const timescale = new Map<number, number>();
  const trexDuration = new Map<number, number>();
  let video = -1;
  const durations: number[] = [];

  const walk = (
    start: number,
    end: number,
    ctx: { track: number; handler: string; tfhd: number },
  ) => {
    let i = start;
    while (i + 8 <= end) {
      let size = u32(i);
      const kind = kindAt(i + 4);
      let header = 8;
      if (size === 1) {
        size = Number(view.getBigUint64(i + 8));
        header = 16;
      } else if (size === 0) {
        size = end - i;
      }
      if (size < header) return;
      const a = i + header;
      const b = Math.min(end, i + size);
      if (kind === 'trak') {
        walk(a, b, { track: -1, handler: '', tfhd: 0 });
      } else if (kind === 'tkhd') {
        ctx.track = u32(a + 4 + (bytes[a] === 1 ? 16 : 8));
      } else if (kind === 'mdhd') {
        timescale.set(ctx.track, u32(a + 4 + (bytes[a] === 1 ? 16 : 8)));
      } else if (kind === 'hdlr') {
        ctx.handler = kindAt(a + 8);
        if (ctx.handler === 'vide') video = ctx.track;
      } else if (kind === 'trex') {
        trexDuration.set(u32(a + 4), u32(a + 12));
      } else if (kind === 'stts' && ctx.handler === 'vide') {
        for (let k = 0, n = u32(a + 4); k < n; k++) {
          const count = u32(a + 8 + 8 * k);
          const delta = u32(a + 12 + 8 * k);
          for (let j = 0; j < count; j++) durations.push(delta);
        }
      } else if (kind === 'tfhd') {
        const flags = u32(a) & 0xffffff;
        ctx.track = u32(a + 4);
        let off = a + 8;
        if (flags & 0x1) off += 8;
        if (flags & 0x2) off += 4;
        ctx.tfhd = flags & 0x8 ? u32(off) : (trexDuration.get(ctx.track) ?? 0);
      } else if (kind === 'trun' && ctx.track === video) {
        const flags = u32(a) & 0xffffff;
        const count = u32(a + 4);
        let off = a + 8;
        if (flags & 0x1) off += 4;
        if (flags & 0x4) off += 4;
        let per = 0;
        for (const bit of [0x100, 0x200, 0x400, 0x800]) if (flags & bit) per += 4;
        for (let k = 0; k < count; k++) {
          durations.push(flags & 0x100 ? u32(off + k * per) : ctx.tfhd);
        }
      } else if (CONTAINERS.has(kind)) {
        walk(a, b, kind === 'traf' ? { track: -1, handler: '', tfhd: 0 } : ctx);
      }
      i += size;
    }
  };
  walk(0, bytes.length, { track: -1, handler: '', tfhd: 0 });
  const scale = timescale.get(video);
  if (video < 0 || !scale || durations.length === 0) return null;
  let total = 0;
  let longest = 0;
  for (const d of durations) {
    total += d;
    longest = Math.max(longest, d);
  }
  const seconds = total / scale;
  return {
    frames: durations.length,
    seconds,
    fps: durations.length / seconds,
    longestGap: longest / scale,
  };
}
