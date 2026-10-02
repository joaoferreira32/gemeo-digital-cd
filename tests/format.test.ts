import { describe, expect, it } from 'vitest';
import { formatClock, formatInt, formatSeconds } from '../src/ui/format';

describe('pt-BR formatting', () => {
  it('uses dot as thousands separator and comma for decimals', () => {
    expect(formatInt(1234567)).toBe('1.234.567');
    expect(formatSeconds(31.64)).toBe('31,6 s');
  });

  it('shows an em dash instead of a fake number when there is no value', () => {
    expect(formatSeconds(NaN)).toBe('—');
  });

  it('formats the simulation clock', () => {
    expect(formatClock(0)).toBe('T+ 00:00:00');
    expect(formatClock(3725.9)).toBe('T+ 01:02:05');
  });
});
