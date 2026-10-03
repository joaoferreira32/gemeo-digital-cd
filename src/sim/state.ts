/**
 * Compact binary encoding of the simulation state, for checkpoints. Values go
 * to two growable streams, one of 32-bit integers (ids, cells, enums, flags)
 * and one of 64-bit floats (times, positions, rates: their exact bits, so a
 * restored world continues bit for bit like the original). Readers consume
 * the streams in the order writers filled them; there are no field names.
 */
export class StateWriter {
  private ints = new Int32Array(4096);
  private floats = new Float64Array(2048);
  private ni = 0;
  private nf = 0;

  int(v: number): void {
    if (this.ni === this.ints.length) {
      const grown = new Int32Array(this.ints.length * 2);
      grown.set(this.ints);
      this.ints = grown;
    }
    this.ints[this.ni++] = v;
  }

  bool(v: boolean): void {
    this.int(v ? 1 : 0);
  }

  float(v: number): void {
    if (this.nf === this.floats.length) {
      const grown = new Float64Array(this.floats.length * 2);
      grown.set(this.floats);
      this.floats = grown;
    }
    this.floats[this.nf++] = v;
  }

  /** Length-prefixed list of integers. */
  ints32(values: ArrayLike<number>): void {
    this.int(values.length);
    for (let i = 0; i < values.length; i++) this.int(values[i] as number);
  }

  /** Length-prefixed list of floats. */
  floats64(values: ArrayLike<number>): void {
    this.int(values.length);
    for (let i = 0; i < values.length; i++) this.float(values[i] as number);
  }

  /** Index of `value` in `options` (throws when it is not one of them). */
  pick<T>(value: T, options: readonly T[]): void {
    const i = options.indexOf(value);
    if (i < 0) throw new Error(`cannot encode ${String(value)}`);
    this.int(i);
  }

  finish(): EncodedState {
    return { ints: this.ints.slice(0, this.ni), floats: this.floats.slice(0, this.nf) };
  }
}

export interface EncodedState {
  readonly ints: Int32Array;
  readonly floats: Float64Array;
}

export class StateReader {
  private ni = 0;
  private nf = 0;

  constructor(private readonly state: EncodedState) {}

  int(): number {
    if (this.ni >= this.state.ints.length) throw new Error('checkpoint ended early (ints)');
    return this.state.ints[this.ni++] as number;
  }

  bool(): boolean {
    return this.int() === 1;
  }

  float(): number {
    if (this.nf >= this.state.floats.length) throw new Error('checkpoint ended early (floats)');
    return this.state.floats[this.nf++] as number;
  }

  ints32(): number[] {
    const n = this.int();
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = this.int();
    return out;
  }

  floats64(): number[] {
    const n = this.int();
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = this.float();
    return out;
  }

  pick<T>(options: readonly T[]): T {
    const i = this.int();
    if (i < 0 || i >= options.length) throw new Error(`bad enum index ${i}`);
    return options[i] as T;
  }

  /** Throws unless every value was read (catches writer/reader drift). */
  end(): void {
    if (this.ni !== this.state.ints.length || this.nf !== this.state.floats.length) {
      throw new Error(
        `checkpoint not fully read: ${this.state.ints.length - this.ni} ints, ` +
          `${this.state.floats.length - this.nf} floats left`,
      );
    }
  }
}
