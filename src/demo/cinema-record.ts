import type { BufferTarget, CanvasSource, Output } from 'mediabunny';

/**
 * Records the cinema demo frame by frame: each frame drawn into the canvas
 * goes to the H.264 encoder (WebCodecs) with its own timestamp, k/60 s, and
 * Mediabunny (MPL-2.0, https://github.com/Vanilagy/mediabunny) writes the MP4.
 * Nothing depends on how fast the page draws: a slow machine takes longer to
 * record, and the file still has 60 frames per second exactly. (The demo of V
 * records in real time with MediaRecorder, src/demo/capture.ts, which gave 54
 * frames per second with a single scene.) The library loads only when a
 * recording starts, so the app does not carry it otherwise.
 */
export class CinemaRecording {
  private constructor(
    private readonly output: Output,
    private readonly source: CanvasSource,
    private readonly fps: number,
  ) {}

  /**
   * A recording of `canvas` (at `bitrate` bits per second, or the library's
   * high quality), or why this browser cannot make one.
   */
  static async open(
    canvas: HTMLCanvasElement,
    fps: number,
    bitrate?: number,
  ): Promise<CinemaRecording | string> {
    if (typeof VideoEncoder === 'undefined') {
      return 'Este navegador não grava vídeo quadro a quadro (WebCodecs): use o Chrome ou o Edge.';
    }
    const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality, canEncodeVideo } =
      await import('mediabunny');
    const quality =
      bitrate === undefined
        ? new Quality('high')
        : new Quality({ bitrate, bitrateMode: 'variable' });
    const options = { width: canvas.width, height: canvas.height, frameRate: fps, quality };
    if (!(await canEncodeVideo('avc', options))) {
      return `Este navegador não codifica H.264 em ${canvas.width}×${canvas.height}: o vídeo não pode ser gravado aqui.`;
    }
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });
    const source = new CanvasSource(canvas, { codec: 'avc', quality, keyFrameInterval: 2 });
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();
    return new CinemaRecording(output, source, fps);
  }

  /** The canvas as it is now, as frame `k` (its time: k / fps). */
  add(k: number): Promise<void> {
    return this.source.add(k / this.fps, 1 / this.fps);
  }

  /** Ends the file. */
  async finish(): Promise<Blob> {
    await this.output.finalize();
    const buffer = (this.output.target as BufferTarget).buffer as ArrayBuffer;
    return new Blob([buffer], { type: 'video/mp4' });
  }

  cancel(): void {
    void this.output.cancel();
  }
}
