/**
 * Records the demo straight from the page (MediaRecorder over a canvas) at
 * 1920×1080 and 60 frames per second. MP4 with H.264 is preferred, since it
 * is what video sites take (LinkedIn among them); WebM only when the browser
 * cannot write MP4, and then the page says so.
 */

export interface VideoFormat {
  readonly mime: string;
  readonly ext: 'mp4' | 'webm';
  /** "MP4 (H.264)", "WebM (VP9)": shown on screen while recording. */
  readonly label: string;
  /** Shown when the format may not be accepted for posting; null for MP4. */
  readonly warning: string | null;
}

/** In order of preference: H.264 in MP4 (several profile strings), then WebM. */
const CANDIDATES: readonly (readonly [string, VideoFormat['ext'], string])[] = [
  ['video/mp4;codecs=avc1.640028', 'mp4', 'MP4 (H.264)'],
  ['video/mp4;codecs=avc1.4d0028', 'mp4', 'MP4 (H.264)'],
  ['video/mp4;codecs=avc1.42e01e', 'mp4', 'MP4 (H.264)'],
  ['video/mp4;codecs=avc1', 'mp4', 'MP4 (H.264)'],
  ['video/mp4', 'mp4', 'MP4'],
  ['video/webm;codecs=vp9', 'webm', 'WebM (VP9)'],
  ['video/webm;codecs=vp8', 'webm', 'WebM (VP8)'],
  ['video/webm', 'webm', 'WebM'],
];

export const WEBM_WARNING =
  'Este navegador só grava em WebM, e o LinkedIn pode não aceitar esse formato: converta o vídeo para MP4 antes de postar.';

/** The first format the browser can record, or null when it records none. */
export function chooseFormat(isSupported: (mime: string) => boolean): VideoFormat | null {
  for (const [mime, ext, label] of CANDIDATES) {
    if (isSupported(mime))
      return { mime, ext, label, warning: ext === 'webm' ? WEBM_WARNING : null };
  }
  return null;
}

export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;
export const VIDEO_FPS = 60;

/** A recording in progress: frames drawn into `canvas` go into the video. */
export class VideoCapture {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  /** Frames drawn into the canvas while recording. */
  drawn = 0;

  constructor(readonly format: VideoFormat) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = VIDEO_WIDTH;
    this.canvas.height = VIDEO_HEIGHT;
    this.context = this.canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D;
  }

  start(): void {
    const stream = this.canvas.captureStream(VIDEO_FPS);
    this.recorder = new MediaRecorder(stream, {
      mimeType: this.format.mime,
      videoBitsPerSecond: 8_000_000,
    });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(1000);
  }

  get recording(): boolean {
    return this.recorder?.state === 'recording';
  }

  /** Ends the recording; the video file. */
  stop(): Promise<Blob> {
    const recorder = this.recorder;
    if (!recorder) return Promise.resolve(new Blob([], { type: this.format.mime }));
    return new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: this.format.mime }));
      recorder.stop();
      for (const track of (recorder.stream as MediaStream).getTracks()) track.stop();
    });
  }
}

/** What the recorded file holds: its duration and the frames it shows (played back at 1×). */
export interface VideoCheck {
  readonly seconds: number;
  readonly frames: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Plays the file once, muted, counting the frames the browser presents
 * (requestVideoFrameCallback): the frame rate of the file as it plays, not of
 * the page while it recorded.
 */
export function checkVideo(blob: Blob): Promise<VideoCheck> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(blob);
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    let first = -1;
    let last = 0;
    let frames = 0;
    const done = () => {
      URL.revokeObjectURL(url);
      const seconds = last - Math.max(0, first);
      resolve({
        seconds,
        frames,
        fps: seconds > 0 ? (frames - 1) / seconds : NaN,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    };
    const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (first < 0) first = meta.mediaTime;
      last = meta.mediaTime;
      frames++;
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    video.onended = done;
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('o navegador não conseguiu tocar o vídeo gravado'));
    };
    void video.play();
  });
}
