import { describe, it, expect } from 'vitest';
import { createState, AvatarState } from '../src/state';

describe('AvatarState', () => {
  it('initializes with idle defaults', () => {
    const s = createState();
    expect(s.mode).toBe('idle');
    expect(s.speaking).toBe(false);
    expect(s.amplitude).toBe(0);
    expect(s.mood).toBeNull();
    expect(s.toolMood).toBeNull();
  });

  it('transitions to thinking', () => {
    const s = createState();
    s.mode = 'thinking';
    expect(s.mode).toBe('thinking');
  });

  it('clears tool mood', () => {
    const s = createState();
    s.toolMood = 'search';
    expect(s.toolMood).toBe('search');
    s.toolMood = null;
    expect(s.toolMood).toBeNull();
  });
});
