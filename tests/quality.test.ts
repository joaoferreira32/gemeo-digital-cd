import { describe, expect, it } from 'vitest';
import { QualityGovernor, type QualityLevel } from '../src/render/quality';

/** Feeds `seconds` of frames at a steady frame rate. */
function run(gov: QualityGovernor, fps: number, seconds: number) {
  const frames = Math.round(fps * seconds);
  for (let i = 0; i < frames; i++) gov.frame(1 / fps);
}

describe('QualityGovernor', () => {
  it('keeps the level while the frame rate is on target', () => {
    const changes: QualityLevel[] = [];
    const gov = new QualityGovernor('alta', (l) => changes.push(l));
    run(gov, 60, 30);
    expect(gov.level).toBe('alta');
    expect(changes).toEqual([]);
    expect(gov.fps).toBeCloseTo(60, 0);
  });

  it('ignores slow frames during warm-up (shader compilation)', () => {
    const gov = new QualityGovernor('alta', () => undefined);
    run(gov, 20, 3); // two warm-up windows
    run(gov, 60, 10);
    expect(gov.level).toBe('alta');
  });

  it('steps down one level at a time when the frame rate stays low', () => {
    const changes: QualityLevel[] = [];
    const gov = new QualityGovernor('alta', (l) => changes.push(l));
    run(gov, 60, 3);
    run(gov, 40, 3.2);
    expect(changes).toEqual(['media']);
    run(gov, 40, 6);
    expect(changes).toEqual(['media', 'baixa']);
    run(gov, 40, 10);
    expect(gov.level).toBe('baixa');
  });

  it('does not react to a single slow window', () => {
    const gov = new QualityGovernor('alta', () => undefined);
    run(gov, 60, 3);
    run(gov, 30, 1.5);
    run(gov, 60, 3);
    expect(gov.level).toBe('alta');
  });

  it('manual cycling wraps around and turns automatic mode off', () => {
    const gov = new QualityGovernor('alta', () => undefined);
    gov.cycle();
    expect(gov.level).toBe('media');
    gov.cycle();
    gov.cycle();
    expect(gov.level).toBe('alta');
    expect(gov.auto).toBe(false);
    run(gov, 60, 3);
    run(gov, 20, 10);
    expect(gov.level).toBe('alta');
  });
});
