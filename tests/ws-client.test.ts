import { describe, it, expect } from 'vitest';
import { parseStatusMessage, parseAudioMessage } from '../src/ws-client';

describe('parseStatusMessage', () => {
  it('parses state thinking', () => {
    const msg = parseStatusMessage('{"state": "thinking"}');
    expect(msg).toEqual({ type: 'state', value: 'thinking' });
  });

  it('parses state idle', () => {
    const msg = parseStatusMessage('{"state": "idle"}');
    expect(msg).toEqual({ type: 'state', value: 'idle' });
  });

  it('parses speaking true', () => {
    const msg = parseStatusMessage('{"speaking": true}');
    expect(msg).toEqual({ type: 'speaking', value: true });
  });

  it('parses speaking false', () => {
    const msg = parseStatusMessage('{"speaking": false}');
    expect(msg).toEqual({ type: 'speaking', value: false });
  });

  it('parses amplitude', () => {
    const msg = parseStatusMessage('{"amplitude": 0.73}');
    expect(msg).toEqual({ type: 'amplitude', value: 0.73 });
  });

  it('parses mood', () => {
    const msg = parseStatusMessage('{"mood": "error"}');
    expect(msg).toEqual({ type: 'mood', value: 'error' });
  });

  it('parses tool_mood', () => {
    const msg = parseStatusMessage('{"tool_mood": "search"}');
    expect(msg).toEqual({ type: 'toolMood', value: 'search' });
  });

  it('returns null for unknown message', () => {
    const msg = parseStatusMessage('{"unknown": 123}');
    expect(msg).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const msg = parseStatusMessage('not json');
    expect(msg).toBeNull();
  });
});

describe('parseAudioMessage', () => {
  it('parses valid audio message', () => {
    const msg = parseAudioMessage('{"pcm": "AQID", "sr": 24000}');
    expect(msg).toEqual({ pcm: 'AQID', sr: 24000 });
  });

  it('returns null for missing fields', () => {
    expect(parseAudioMessage('{"pcm": "AQID"}')).toBeNull();
    expect(parseAudioMessage('{"sr": 24000}')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseAudioMessage('bad')).toBeNull();
  });
});
