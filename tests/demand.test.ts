import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { demandWeight, hourLabel, hourOfWeek, type DemandProfile } from '../src/sim/demand';
import { fingerprint } from '../src/sim/fingerprint';
import { SURGE_FACTOR } from '../src/sim/failures';
import { World } from '../src/sim/world';

const SECOND = 60;
const olist = JSON.parse(readFileSync('public/demanda-olist.json', 'utf-8')) as {
  weights: number[];
  orders: number;
  license: string;
  url: string;
};

/** A made-up week: weight 0.5 + the hour of the day ÷ 24. */
const ramp: DemandProfile = {
  weights: Array.from({ length: 168 }, (_, h) => 0.5 + (h % 24) / 24),
  secondsPerHour: 10,
  startHour: 22,
};

describe('demand profile', () => {
  it('maps simulated time to the hours of the week, wrapping after Sunday', () => {
    expect(hourOfWeek(ramp, 0)).toBe(22);
    expect(hourOfWeek(ramp, 9.99)).toBe(22);
    expect(hourOfWeek(ramp, 10)).toBe(23);
    expect(hourOfWeek({ ...ramp, startHour: 167 }, 10)).toBe(0);
    expect(hourLabel(0)).toBe('segunda, 0h');
    expect(hourLabel(24 * 4 + 14)).toBe('sexta, 14h');
  });

  it('the order rate is the base rate times the weight of the hour', () => {
    const w = new World({ seed: 3, robots: 0, arrivalRate: 2, demand: ramp });
    expect(w.currentArrivalRate).toBeCloseTo(2 * demandWeight(ramp, 0), 12);
    w.stepMany(10 * SECOND);
    expect(w.currentArrivalRate).toBeCloseTo(2 * (0.5 + 23 / 24), 12);
    w.stepMany(15 * SECOND);
    expect(w.currentArrivalRate).toBeCloseTo(2 * (0.5 + 0 / 24), 12);
    // The orders of the racks (robots) follow the same weight.
    const r = new World({ seed: 3, demand: ramp });
    const rack = r.config.rackOrderRate;
    expect(r.fleet!.rackOrderRate).toBeCloseTo(rack * demandWeight(ramp, 0), 12);
    r.stepMany(10 * SECOND);
    expect(r.fleet!.rackOrderRate).toBeCloseTo(rack * (0.5 + 23 / 24), 12);
  });

  it('a surge multiplies the rate of the hour, and the hour takes over again after it', () => {
    const w = new World({ seed: 3, robots: 0, arrivalRate: 2, demand: ramp });
    w.stepMany(5 * SECOND);
    const surge = w.failures.inject('surge', w.time)!;
    expect(w.currentArrivalRate).toBeCloseTo(2 * SURGE_FACTOR * demandWeight(ramp, w.time), 12);
    w.stepMany(Math.ceil((surge.endsAt - w.time) * SECOND) + SECOND);
    expect(w.surging).toBe(false);
    expect(w.currentArrivalRate).toBeCloseTo(2 * demandWeight(ramp, w.time), 12);
  });

  it('the forecast of the maintenance schedule knows the hours ahead', () => {
    const w = new World({ seed: 3, robots: 0, arrivalRate: 2, demand: ramp });
    for (const t of [0, 12, 33, 100]) {
      expect(w.forecastRate(t)).toBeCloseTo(2 * demandWeight(ramp, t), 12);
    }
  });

  it('the orders of a simulated day follow the Olist weights', () => {
    const demand: DemandProfile = { weights: olist.weights, secondsPerHour: 60, startHour: 0 };
    const w = new World({ seed: 5, robots: 0, arrivalRate: 3, demand });
    const perHour: number[] = [];
    for (let h = 0; h < 24; h++) {
      const before = w.metrics.created;
      w.stepMany(60 * SECOND);
      perHour.push(w.metrics.created - before);
    }
    const expected = olist.weights.slice(0, 24).map((x) => x * 3 * 60);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const [ma, mb] = [mean(perHour), mean(expected)];
    let num = 0;
    let da = 0;
    let db = 0;
    perHour.forEach((a, i) => {
      const b = expected[i] as number;
      num += (a - ma) * (b - mb);
      da += (a - ma) ** 2;
      db += (b - mb) ** 2;
    });
    expect(num / Math.sqrt(da * db)).toBeGreaterThan(0.95);
    // The day's total is the day's mean weight times the rate, within Poisson noise.
    expect(Math.abs(ma / mb - 1)).toBeLessThan(0.05);
  });

  it('restored in the middle of an hour, a world with a profile continues bit for bit', () => {
    const demand: DemandProfile = { weights: olist.weights, secondsPerHour: 60, startHour: 8 };
    const live = new World({ seed: 7, demand });
    live.stepMany(95 * SECOND);
    const cp = live.saveState();
    live.stepMany(90 * SECOND);
    const restored = new World({ seed: 7, demand });
    restored.loadState(cp);
    restored.stepMany(90 * SECOND);
    expect(fingerprint(restored)).toBe(fingerprint(live));
    expect(restored.currentArrivalRate).toBe(live.currentArrivalRate);
  }, 30_000);

  it('refuses a profile without 168 weights', () => {
    expect(() => new World({ demand: { ...ramp, weights: [1, 2] } })).toThrow(/168 weights/);
  });

  it('the Olist profile: 168 weights averaging 1, quiet nights, busy afternoons, its license beside it', () => {
    const w = olist.weights;
    expect(w).toHaveLength(168);
    expect(w.reduce((a, b) => a + b, 0) / 168).toBeCloseTo(1, 3);
    expect(w.every((x) => x > 0)).toBe(true);
    for (let d = 0; d < 7; d++) {
      expect(w[d * 24 + 4]!).toBeLessThan(0.2); // 4h
      expect(w[d * 24 + 15]!).toBeGreaterThan(0.9); // 15h
    }
    expect(olist.license).toMatch(/CC BY-NC-SA 4\.0/);
    expect(olist.url).toBe('https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce');
    const license = readFileSync('public/demanda-olist.LICENSE.txt', 'utf-8');
    expect(license).toMatch(/CC BY-NC-SA 4\.0/);
    expect(license).toMatch(/https:\/\/www\.kaggle\.com\/datasets\/olistbr\/brazilian-ecommerce/);
  });
});

/** The Python of the machine (the script uses only its standard library), or null. */
function python(): string | null {
  for (const cmd of ['python3', 'python']) {
    if (spawnSync(cmd, ['--version']).status === 0) return cmd;
  }
  return null;
}

describe('the Olist dataset stays out of the repository', () => {
  it('ignores its CSVs and archives in any case, and keeps only the derived profile', () => {
    // As on Linux and macOS, where OLIST.CSV and olist.csv are different files.
    const ignored = (paths: string[]) =>
      spawnSync('git', ['-c', 'core.ignorecase=false', 'check-ignore', ...paths], {
        encoding: 'utf-8',
      })
        .stdout.split(/\r?\n/)
        .filter(Boolean);
    const dataset = [
      'olist_orders_dataset.csv',
      'OLIST_ORDERS_DATASET.CSV',
      'olist_orders_dataset.CSV',
      'public/Olist_orders.csv',
      'dados-olist/qualquer.csv',
      'brazilian-ecommerce.zip',
      'Brazilian-Ecommerce/olist_customers_dataset.csv',
      'olist.zip',
    ];
    expect(ignored(dataset)).toEqual(dataset);
    const ours = ['public/demanda-olist.json', 'public/demanda-olist.LICENSE.txt'];
    expect(ignored(ours)).toEqual([]);
    const tracked = spawnSync('git', ['ls-files'], { encoding: 'utf-8' }).stdout.split(/\r?\n/);
    expect(tracked.filter((f) => /olist/i.test(f) && /\.(csv|zip)$/i.test(f))).toEqual([]);
  });
});

describe('scripts/demanda_olist.py', () => {
  const py = python();
  it.skipIf(!py)(
    'averages the orders per hour of the week over the period, leaving out what is outside it',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'olist-'));
      try {
        const csv = join(dir, 'orders.csv');
        const out = join(dir, 'perfil.json');
        const row = (ts: string) => `x,y,delivered,${ts},,,,`;
        writeFileSync(
          csv,
          [
            'order_id,customer_id,order_status,order_purchase_timestamp,order_approved_at,order_delivered_carrier_date,order_delivered_customer_date,order_estimated_delivery_date',
            row('2016-12-15 10:00:00'), // before the period
            row('2017-01-02 10:15:00'), // Monday 10h
            row('2017-01-09 10:59:59'), // Monday 10h
            row('2017-01-07 15:30:00'), // Saturday 15h
            row('2017-11-24 12:00:00'), // Black Friday week
            row('2018-09-03 09:00:00'), // after the period
          ].join('\n') + '\n',
        );
        const run = spawnSync(py as string, ['scripts/demanda_olist.py', csv, out], {
          encoding: 'utf-8',
        });
        expect(run.status, run.stderr).toBe(0);
        const p = JSON.parse(readFileSync(out, 'utf-8')) as { orders: number; weights: number[] };
        expect(p.orders).toBe(3);
        // How many Mondays and Saturdays the period has, Black Friday week left out: 86 and 85
        // (87 and 86 with it). Not a Tuesday: as many Tuesdays as Mondays, and the ratio of the
        // two weights would not see that week.
        const count = (weekday: number) => {
          let n = 0;
          for (
            let d = new Date(Date.UTC(2017, 0, 1));
            d < new Date(Date.UTC(2018, 8, 1));
            d.setUTCDate(d.getUTCDate() + 1)
          ) {
            const inBlackFriday =
              d >= new Date(Date.UTC(2017, 10, 20)) && d < new Date(Date.UTC(2017, 10, 27));
            if (!inBlackFriday && (d.getUTCDay() + 6) % 7 === weekday) n++;
          }
          return n;
        };
        const monday = 2 / count(0);
        const saturday = 1 / count(5);
        const mean = (monday + saturday) / 168;
        expect(p.weights[10]).toBeCloseTo(monday / mean, 3);
        expect(p.weights[5 * 24 + 15]).toBeCloseTo(saturday / mean, 3);
        expect(p.weights.filter((x) => x !== 0)).toHaveLength(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
