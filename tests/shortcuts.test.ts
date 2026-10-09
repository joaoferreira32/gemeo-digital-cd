import { describe, expect, it } from 'vitest';
import { CAMERA_KEYS, SHORTCUTS, shiftedElsewhere, shortcutFor } from '../src/ui/shortcuts';

describe('shortcut table', () => {
  it('no key does two things', () => {
    const seen = new Map<string, string>();
    for (const s of SHORTCUTS) {
      for (const code of s.codes) {
        const key = `${s.shift ? 'Shift+' : ''}${code}`;
        expect(seen.get(key), `${key}: "${s.help}" e "${seen.get(key)}"`).toBeUndefined();
        seen.set(key, s.help);
      }
    }
  });

  it('the camera keys in the table are exactly the ones the camera reads', () => {
    const inTable = SHORTCUTS.filter((s) => s.action === 'camera')
      .flatMap((s) => s.codes)
      .sort();
    expect(inTable).toEqual(Object.values(CAMERA_KEYS).flat().sort());
  });

  it('⇧R restarts; R alone tilts the camera, which leaves R alone while Shift is down', () => {
    expect(shortcutFor('KeyR', true)?.action).toBe('restart');
    expect(shortcutFor('KeyR', false)).toBeUndefined();
    expect(shiftedElsewhere('KeyR')).toBe(true);
    // "+" is Shift + "=" on most layouts: still a zoom.
    expect(shiftedElsewhere('Equal')).toBe(false);
  });

  it('V runs the demo and ⇧V records it', () => {
    expect(shortcutFor('KeyV', false)?.action).toBe('demo');
    expect(shortcutFor('KeyV', true)?.action).toBe('record');
  });

  it('a key with no Shift shortcut answers with or without Shift', () => {
    expect(shortcutFor('Digit5', false)?.action).toBe('failure');
    expect(shortcutFor('Digit5', true)?.action).toBe('failure');
  });

  it('L is still "back to live" (the timeline), and every line of the help says something', () => {
    expect(shortcutFor('KeyL', false)?.action).toBe('live');
    for (const s of SHORTCUTS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.help.trim()).not.toBe('');
    }
  });
});
