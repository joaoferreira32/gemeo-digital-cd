import { conveyorCapacity, type Conveyor } from './conveyor';
import type { Degradation } from './failures';
import { deriveSeed, Rng } from './rng';
import type { StateReader, StateWriter } from './state';

/**
 * Condition monitoring of the conveyor motors (predictive maintenance).
 *
 * THE SIGNALS ARE SIMULATED, from a deliberately simple model; nothing here
 * was measured on a real machine. Once per simulated second every motor
 * reports its vibration (mm/s RMS) and its temperature (°C):
 *
 *   vibration    baseline + effect of the load + effect of wear
 *                + disturbances + noise
 *   temperature  first-order lag (90 s) toward ambient + motor heat
 *                + effect of the load + effect of wear + disturbances;
 *                plus noise
 *
 * The load is how full the belt is. Each motor has its own baseline and its
 * own response to load, which the nominal model of the monitoring does not
 * know (it only has rough commissioning values). Wear grows from 0 to 1
 * between the onset of a degradation and the breakdown it ends in
 * (failures.ts schedules both); how strongly it shows on each signal varies
 * from one degradation to the next, and some are faint. Disturbances have
 * nothing to do with wear and are what a detector must not alarm on: knocks
 * (a heavy box hitting the belt: a vibration spike of a second or two) and
 * jams (a box rubbing against the rail for 5 to 30 s: more vibration and some
 * heat). The noise comes from a random stream of its own, so the signals
 * never change anything else in the simulation.
 *
 * Detection, per motor:
 *  1. A small Kalman filter learns how this motor departs from the nominal
 *     model (an offset and a load slope for each signal) and predicts the
 *     next readings. It learns only from readings within 3 spreads of its
 *     prediction, and slowly once it has settled (about 15 minutes), so the
 *     wear, which pushes the readings well above it, is not absorbed. When a
 *     motor starts again after a stop, the twin takes the measured
 *     temperature as its thermal state (a motor that broke while hot comes
 *     back warmer than the model would think) and that difference fades with
 *     the thermal lag.
 *  2. z = how far both readings are above the prediction, each divided by
 *     the spread the filter expects and capped at 4 (so one knock cannot
 *     raise the alarm alone), combined: (zv + zt) / √2.
 *  3. One-sided CUSUM: S ← max(0, S + z − k). The alarm goes up when S
 *     reaches h and down when S is back to 0 or the motor stops.
 * k and h are calibrated on the validation seeds (npm run bench:manutencao).
 */

export interface DetectorParams {
  /** Allowance k, in z units: smaller deviations do not accumulate. */
  readonly allowance: number;
  /** Threshold h: the alarm goes up when the sum reaches it. */
  readonly threshold: number;
}

/**
 * Calibrated on the validation seeds (npm run bench:manutencao -- --calibrate):
 * the best F1 of a 7 × 8 grid. A large k and h mean the alarm waits until the
 * anomaly outlasts a typical jam, which is what keeps the false alarms rare.
 */
export const DEFAULT_DETECTOR: DetectorParams = { allowance: 3, threshold: 48 };

const AMBIENT = 25;
const LAG = 1 - Math.exp(-1 / 90);
/** The nominal model: the same for every motor (the truth varies per motor). */
const NOMINAL = { vibrationPerLoad: 0.5, heatPerLoad: 10 } as const;
const NOISE = { vibration: 0.12, temperature: 0.3 } as const;
/** Effect of wear on each signal at the moment of the breakdown, at severity 1. */
const WEAR = { vibration: 3.5, temperature: 14 } as const;
const SEVERITY: readonly [number, number] = [0.05, 1.3];
/**
 * Disturbances: per motor and second, how likely one starts; its extra
 * vibration (mm/s), extra heat (°C toward which the motor warms) and length (s).
 */
const KNOCK = { chance: 2 / 3600, vibration: [1.5, 4], heat: [0, 0], seconds: [1, 2] } as const;
const JAM = { chance: 1 / 3600, vibration: [0.5, 1.5], heat: [3, 6], seconds: [5, 30] } as const;
/** Cap of each signal's z score. */
const Z_CAP = 4;

/**
 * The learning filter of each signal: prior spread of the offset and of the
 * slope (how far a motor may be from the nominal model) and the measurement
 * variance. Once settled, the filter follows a change in about ADAPT seconds.
 */
const FILTER = {
  vibration: { offset: 0.2, slope: 0.3, measurement: 0.13 ** 2 },
  temperature: { offset: 1.5, slope: 4, measurement: 0.33 ** 2 },
} as const;
const ADAPT = 900;
/** Readings farther than this from the prediction (in spreads) are not learned from. */
const LEARN_WITHIN = 3;

function gaussian(rng: Rng): number {
  // Box–Muller; 1 − next() is in (0, 1], so the log is finite.
  const u = 1 - rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

/**
 * Kalman filter of a linear correction y ≈ a·φ0 + b·φ1, for all motors of
 * one signal: estimates (a, b) and their covariance (p00, p01, p11) per motor.
 */
class Correction {
  readonly a: Float64Array;
  readonly b: Float64Array;
  readonly p00: Float64Array;
  readonly p01: Float64Array;
  readonly p11: Float64Array;
  private readonly q00: number;
  private readonly q11: number;

  constructor(
    motors: number,
    prior: { offset: number; slope: number; measurement: number },
    private readonly r = prior.measurement,
  ) {
    this.a = new Float64Array(motors);
    this.b = new Float64Array(motors);
    this.p00 = new Float64Array(motors).fill(prior.offset ** 2);
    this.p01 = new Float64Array(motors);
    this.p11 = new Float64Array(motors).fill(prior.slope ** 2);
    // Random-walk drift that gives a settled gain of about 1 / ADAPT per second.
    this.q00 = prior.measurement / ADAPT ** 2;
    this.q11 = this.q00 * (prior.slope / prior.offset) ** 2;
  }

  predict(i: number, f0: number, f1: number): number {
    return (this.a[i] as number) * f0 + (this.b[i] as number) * f1;
  }

  /** Prediction error of the last innovation and its expected variance (z = e / √s). */
  e = 0;
  s = 0;

  /** Sets `e` and `s` for motor i (fields, not an object: it runs for every motor every second). */
  innovation(i: number, y: number, f0: number, f1: number): void {
    const p00 = (this.p00[i] as number) + this.q00;
    const p01 = this.p01[i] as number;
    const p11 = (this.p11[i] as number) + this.q11;
    this.p00[i] = p00;
    this.p11[i] = p11;
    this.e = y - this.predict(i, f0, f1);
    this.s = f0 * (p00 * f0 + p01 * f1) + f1 * (p01 * f0 + p11 * f1) + this.r;
  }

  /** Learns from the last innovation of motor i. */
  learn(i: number, e: number, s: number, f0: number, f1: number): void {
    const p00 = this.p00[i] as number;
    const p01 = this.p01[i] as number;
    const p11 = this.p11[i] as number;
    const g0 = p00 * f0 + p01 * f1;
    const g1 = p01 * f0 + p11 * f1;
    this.a[i] = (this.a[i] as number) + (g0 / s) * e;
    this.b[i] = (this.b[i] as number) + (g1 / s) * e;
    this.p00[i] = p00 - (g0 * g0) / s;
    this.p01[i] = p01 - (g0 * g1) / s;
    this.p11[i] = p11 - (g1 * g1) / s;
  }

  save(w: StateWriter): void {
    for (const x of [this.a, this.b, this.p00, this.p01, this.p11]) w.floats64(x);
  }

  load(r: StateReader): void {
    for (const x of [this.a, this.b, this.p00, this.p01, this.p11]) x.set(r.floats64());
  }
}

export class MotorHealth {
  /** Latest readings, per conveyor. */
  readonly vibration: Float64Array;
  readonly temperature: Float64Array;
  /** Latest z score and CUSUM sum, per conveyor. */
  readonly score: Float64Array;
  readonly sum: Float64Array;
  /** 1 while the alarm of a conveyor is up. */
  readonly alarm: Uint8Array;
  readonly params: DetectorParams;
  /** Called with the z score of every running motor each second (calibration); not state. */
  onScore: ((motor: number, z: number) => void) | null = null;

  private readonly rng: Rng;
  // Per motor, fixed from the seed: the truth, and the commissioning values.
  private readonly base: Float64Array;
  private readonly heat: Float64Array;
  private readonly vibrationPerLoad: Float64Array;
  private readonly heatPerLoad: Float64Array;
  private readonly baseNominal: Float64Array;
  private readonly heatNominal: Float64Array;
  // Changing state.
  private readonly trueTemperature: Float64Array;
  /** Running and load·running through the thermal lag (inputs of the temperature model). */
  private readonly lagRun: Float64Array;
  private readonly lagLoad: Float64Array;
  /** Measured minus modelled temperature when the motor started again, fading with the lag. */
  private readonly thermalOffset: Float64Array;
  private readonly wasRunning: Uint8Array;
  private readonly vibrationFilter: Correction;
  private readonly temperatureFilter: Correction;
  private readonly severityV: Float64Array;
  private readonly severityT: Float64Array;
  /** Id of the degradation each motor's severities belong to (-1 for none). */
  private readonly degradation: Int32Array;
  /** Seconds left of the disturbance on each motor, and its effects. */
  private readonly disturbanceLeft: Int32Array;
  private readonly disturbanceVibration: Float64Array;
  private readonly disturbanceHeat: Float64Array;

  constructor(motors: number, seed: number, params: Partial<DetectorParams> = {}) {
    this.params = { ...DEFAULT_DETECTOR, ...params };
    this.rng = new Rng(deriveSeed(seed, 'health'));
    const f = () => new Float64Array(motors);
    this.vibration = f();
    this.temperature = f();
    this.score = f();
    this.sum = f();
    this.alarm = new Uint8Array(motors);
    this.base = f();
    this.heat = f();
    this.vibrationPerLoad = f();
    this.heatPerLoad = f();
    this.baseNominal = f();
    this.heatNominal = f();
    this.trueTemperature = f();
    this.lagRun = new Float64Array(motors).fill(1);
    this.lagLoad = f();
    this.thermalOffset = f();
    this.wasRunning = new Uint8Array(motors).fill(1);
    this.vibrationFilter = new Correction(motors, FILTER.vibration);
    this.temperatureFilter = new Correction(motors, FILTER.temperature);
    this.severityV = f();
    this.severityT = f();
    this.degradation = new Int32Array(motors).fill(-1);
    this.disturbanceLeft = new Int32Array(motors);
    this.disturbanceVibration = f();
    this.disturbanceHeat = f();
    const r = this.rng;
    for (let i = 0; i < motors; i++) {
      this.base[i] = r.range(1.6, 2.4);
      this.heat[i] = r.range(10, 14);
      this.vibrationPerLoad[i] = r.range(0.3, 0.7);
      this.heatPerLoad[i] = r.range(7, 13);
      // Commissioning measured the baselines, with an error.
      this.baseNominal[i] = (this.base[i] as number) + 0.1 * gaussian(r);
      this.heatNominal[i] = (this.heat[i] as number) + 0.8 * gaussian(r);
      this.trueTemperature[i] = AMBIENT + (this.heat[i] as number);
      this.vibration[i] = this.base[i] as number;
      this.temperature[i] = this.trueTemperature[i] as number;
    }
  }

  /** Alarm level 0 … 1 of a conveyor (the sum over the threshold), for the halo. */
  risk(motor: number): number {
    return Math.min(1, (this.sum[motor] as number) / this.params.threshold);
  }

  /**
   * One second of readings and detection. `raise` is called when the alarm
   * of a conveyor goes up.
   */
  update(
    now: number,
    conveyors: readonly Conveyor[],
    degrading: readonly Degradation[],
    raise: (motor: number) => void,
  ): void {
    const { allowance, threshold } = this.params;
    const r = this.rng;
    for (let i = 0; i < conveyors.length; i++) {
      const c = conveyors[i] as Conveyor;
      const running = c.status === 'ok';
      const load = c.packets.length / conveyorCapacity(c);
      let wear = 0;
      for (const d of degrading) {
        if (d.target !== i || !running) continue;
        if (this.degradation[i] !== d.id) {
          this.degradation[i] = d.id;
          this.severityV[i] = r.range(SEVERITY[0], SEVERITY[1]);
          this.severityT[i] = r.range(SEVERITY[0], SEVERITY[1]);
        }
        wear = Math.min(1, Math.max(0, (now - d.onset) / (d.breaksAt - d.onset)));
      }

      // The motor, as simulated.
      const gv = gaussian(r);
      const gt = gaussian(r);
      const u = r.next();
      if (this.disturbanceLeft[i] === 0 && u < KNOCK.chance + JAM.chance) {
        const d = u < KNOCK.chance ? KNOCK : JAM;
        this.disturbanceLeft[i] = Math.round(r.range(d.seconds[0], d.seconds[1]));
        this.disturbanceVibration[i] = r.range(d.vibration[0], d.vibration[1]);
        this.disturbanceHeat[i] = r.range(d.heat[0], d.heat[1]);
      }
      let shake = 0;
      let rub = 0;
      if ((this.disturbanceLeft[i] as number) > 0) {
        this.disturbanceLeft[i]!--;
        shake = this.disturbanceVibration[i] as number;
        rub = this.disturbanceHeat[i] as number;
      }
      // The wear terms are exactly 0 without wear: skipping them gives the same bits.
      let heatTarget = AMBIENT;
      if (running) {
        heatTarget = AMBIENT + (this.heat[i] as number) + (this.heatPerLoad[i] as number) * load;
        if (wear > 0) heatTarget += (this.severityT[i] as number) * WEAR.temperature * wear ** 1.5;
        heatTarget += rub;
      }
      this.trueTemperature[i] =
        (this.trueTemperature[i] as number) +
        (heatTarget - (this.trueTemperature[i] as number)) * LAG;
      let vibration = 0.05 * Math.abs(gv);
      if (running) {
        vibration = (this.base[i] as number) + (this.vibrationPerLoad[i] as number) * load;
        if (wear > 0) vibration += (this.severityV[i] as number) * WEAR.vibration * wear * wear;
        vibration = vibration + shake + NOISE.vibration * gv;
      }
      const temperature = (this.trueTemperature[i] as number) + NOISE.temperature * gt;
      this.vibration[i] = vibration;
      this.temperature[i] = temperature;

      // The monitoring: nominal model, learned correction, CUSUM.
      const lagRun =
        (this.lagRun[i] as number) + ((running ? 1 : 0) - (this.lagRun[i] as number)) * LAG;
      const lagLoad =
        (this.lagLoad[i] as number) + ((running ? load : 0) - (this.lagLoad[i] as number)) * LAG;
      this.lagRun[i] = lagRun;
      this.lagLoad[i] = lagLoad;
      if (!running) {
        this.score[i] = 0;
        this.sum[i] = 0;
        this.alarm[i] = 0;
        this.wasRunning[i] = 0;
        continue;
      }
      const yv = vibration - (this.baseNominal[i] as number) - NOMINAL.vibrationPerLoad * load;
      let yt =
        temperature -
        AMBIENT -
        (this.heatNominal[i] as number) * lagRun -
        NOMINAL.heatPerLoad * lagLoad;
      if (!this.wasRunning[i]) {
        this.thermalOffset[i] = yt - this.temperatureFilter.predict(i, lagRun, lagLoad);
        this.wasRunning[i] = 1;
      }
      yt -= this.thermalOffset[i] as number;
      this.thermalOffset[i] = (this.thermalOffset[i] as number) * (1 - LAG);
      const vf = this.vibrationFilter;
      const tf = this.temperatureFilter;
      vf.innovation(i, yv, 1, load);
      tf.innovation(i, yt, lagRun, lagLoad);
      const { e: ve, s: vs } = vf;
      const { e: te, s: ts } = tf;
      const vSpread = Math.sqrt(vs);
      const tSpread = Math.sqrt(ts);
      const z = (Math.min(Z_CAP, ve / vSpread) + Math.min(Z_CAP, te / tSpread)) / Math.SQRT2;
      this.score[i] = z;
      this.onScore?.(i, z);
      const sum = Math.max(0, (this.sum[i] as number) + z - allowance);
      this.sum[i] = sum;
      if (!this.alarm[i] && sum >= threshold) {
        this.alarm[i] = 1;
        raise(i);
      } else if (this.alarm[i] && sum === 0) {
        this.alarm[i] = 0;
      }
      if (Math.abs(ve) < LEARN_WITHIN * vSpread) vf.learn(i, ve, vs, 1, load);
      if (Math.abs(te) < LEARN_WITHIN * tSpread) tf.learn(i, te, ts, lagRun, lagLoad);
    }
  }

  save(w: StateWriter): void {
    w.int(this.rng.getState());
    for (const a of [
      this.vibration,
      this.temperature,
      this.score,
      this.sum,
      this.trueTemperature,
      this.lagRun,
      this.lagLoad,
      this.thermalOffset,
      this.severityV,
      this.severityT,
    ]) {
      w.floats64(a);
    }
    w.ints32(this.alarm);
    w.ints32(this.wasRunning);
    w.ints32(this.degradation);
    w.ints32(this.disturbanceLeft);
    w.floats64(this.disturbanceVibration);
    w.floats64(this.disturbanceHeat);
    this.vibrationFilter.save(w);
    this.temperatureFilter.save(w);
  }

  load(r: StateReader): void {
    this.rng.setState(r.int());
    for (const a of [
      this.vibration,
      this.temperature,
      this.score,
      this.sum,
      this.trueTemperature,
      this.lagRun,
      this.lagLoad,
      this.thermalOffset,
      this.severityV,
      this.severityT,
    ]) {
      a.set(r.floats64());
    }
    this.alarm.set(r.ints32());
    this.wasRunning.set(r.ints32());
    this.degradation.set(r.ints32());
    this.disturbanceLeft.set(r.ints32());
    this.disturbanceVibration.set(r.floats64());
    this.disturbanceHeat.set(r.floats64());
    this.vibrationFilter.load(r);
    this.temperatureFilter.load(r);
  }
}
