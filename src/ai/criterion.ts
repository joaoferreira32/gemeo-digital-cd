import { SCENARIOS, type EvalResult, type ScenarioName } from './evaluate';
import { paired, type Paired } from './stats';

/**
 * The success criterion of the learning agent against the heuristic, fixed
 * before any training (phase 4 plan, with the additions of the review). The
 * episodes are paired by seed and scenario (10 seeds × 4 scenarios):
 *
 *  1. the p95 of the cycle is better in at least 7 of every 10 pairs;
 *  2. the mean p95 gain is at least 3%, with its 95% interval above 0;
 *  3. no throughput loss: the 95% interval of the change is not all below 0;
 *  4. in no scenario alone is the p95 significantly worse (interval all below 0);
 *  5. neither the p99 of the cycle nor the worst age of a waiting packet is
 *     significantly worse, overall or in any scenario (no packet "forgotten"
 *     to make the average look better).
 */
export interface CriterionCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CriterionResult {
  readonly ok: boolean;
  readonly checks: CriterionCheck[];
}

export interface Pair {
  readonly scenario: ScenarioName;
  readonly base: EvalResult;
  readonly cand: EvalResult;
}

const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
const interval = (p: Paired) => `${pct(p.mean)} (IC 95% ${pct(p.low)} a ${pct(p.high)})`;

export function criterion(pairs: readonly Pair[]): CriterionResult {
  const stat = (ps: readonly Pair[], key: keyof EvalResult, lowerIsBetter = true) =>
    paired(
      ps.map((p) => p.base[key] as number),
      ps.map((p) => p.cand[key] as number),
      lowerIsBetter,
    );
  const p95 = stat(pairs, 'cycleP95');
  const checks: CriterionCheck[] = [
    {
      label: 'p95 melhor em pelo menos 7 de cada 10 pares',
      ok: p95.wins >= 0.7 * p95.n,
      detail: `${p95.wins} de ${p95.n}`,
    },
    {
      label: 'ganho médio no p95 ≥ 3% com IC 95% acima de 0',
      ok: p95.mean >= 0.03 && p95.low > 0,
      detail: interval(p95),
    },
  ];
  const tp = stat(pairs, 'throughputPerMin', false);
  checks.push({ label: 'sem perda de vazão', ok: tp.high >= 0, detail: interval(tp) });
  for (const scenario of SCENARIOS) {
    const ps = pairs.filter((p) => p.scenario === scenario);
    if (!ps.length) continue;
    const s = stat(ps, 'cycleP95');
    checks.push({ label: `p95 não piora em ${scenario}`, ok: s.high >= 0, detail: interval(s) });
  }
  for (const [key, name] of [
    ['cycleP99', 'p99 do ciclo'],
    ['oldestMax', 'idade máxima de um pacote'],
  ] as const) {
    const all = stat(pairs, key);
    const worst = SCENARIOS.map((scenario) => ({
      scenario,
      s: stat(
        pairs.filter((p) => p.scenario === scenario),
        key,
      ),
    })).filter((x) => x.s.n > 0);
    const bad = worst.filter((x) => x.s.high < 0).map((x) => x.scenario);
    checks.push({
      label: `${name} não piora (no total e em cada cenário)`,
      ok: all.high >= 0 && bad.length === 0,
      detail: `${interval(all)}${bad.length ? `; piora em ${bad.join(', ')}` : ''}`,
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}
