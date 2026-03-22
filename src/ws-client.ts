import { AvatarState } from './state';

export type StatusMessage =
  | { type: 'state'; value: 'thinking' | 'idle' }
  | { type: 'speaking'; value: boolean }

  | { type: 'mood'; value: string }
  | { type: 'toolMood'; value: string }
  | { type: 'text'; value: string; duration: number };

export function parseStatusMessage(raw: string): StatusMessage | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if ('state' in data) return { type: 'state', value: data.state as 'thinking' | 'idle' };
  if ('text' in data) return { type: 'text', value: data.text as string, duration: (data.duration as number) || 0 };
  if ('speaking' in data) return { type: 'speaking', value: data.speaking as boolean };

  if ('mood' in data) return { type: 'mood', value: data.mood as string };
  if ('tool_mood' in data) return { type: 'toolMood', value: data.tool_mood as string };

  return null;
}

export type AudioMessage = {
  pcm: string;
  sr: number;
  fmt?: 'f32' | 'i16';
};

export function parseAudioMessage(raw: string): AudioMessage | null {
  try {
    const data = JSON.parse(raw);
    if ('pcm' in data && 'sr' in data) return data as AudioMessage;
    return null;
  } catch {
    return null;
  }
}

const STATUS_URL = 'ws://127.0.0.1:5111/ws/status';
const AUDIO_URL = 'ws://127.0.0.1:5111/ws/audio';
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

export function connectStatus(
  state: AvatarState,
  onMessage?: (msg: StatusMessage) => void,
): void {
  let reconnectMs = RECONNECT_BASE_MS;

  function connect() {
    const ws = new WebSocket(STATUS_URL);

    ws.onopen = () => { reconnectMs = RECONNECT_BASE_MS; }; // reset on success

    ws.onmessage = (event) => {
      const msg = parseStatusMessage(event.data);
      if (!msg) return;

      switch (msg.type) {
        case 'state':
          state.mode = msg.value === 'thinking' ? 'thinking' : 'idle';
          break;
        case 'speaking':
          // Handled by onMessage callback (main.ts) with debounce delay
          break;

        case 'mood':
          state.mood = msg.value as AvatarState['mood'];
          break;
        case 'toolMood':
          state.toolMood = msg.value as AvatarState['toolMood'];
          break;
      }

      onMessage?.(msg);
    };

    ws.onclose = () => {
      setTimeout(connect, reconnectMs);
      reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
    };
    ws.onerror = () => ws.close();
  }

  connect();
}

export function connectAudio(
  onAudio: (pcm: Float32Array, sampleRate: number) => void,
): void {
  let reconnectMs = RECONNECT_BASE_MS;

  function connect() {
    const ws = new WebSocket(AUDIO_URL);

    ws.onopen = () => { reconnectMs = RECONNECT_BASE_MS; };

    ws.onmessage = (event) => {
      const msg = parseAudioMessage(event.data);
      if (!msg) return;

      const binary = atob(msg.pcm);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const pcm = new Float32Array(bytes.buffer);
      onAudio(pcm, msg.sr);
    };

    ws.onclose = () => {
      setTimeout(connect, reconnectMs);
      reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
    };
    ws.onerror = () => ws.close();
  }

  connect();
}
