export type Mode = 'idle' | 'thinking' | 'speaking';
export type Mood = 'default' | 'error' | 'success' | 'warn' | 'melancholy' | null;
export type ToolMood = 'search' | 'execute' | 'agent' | null;

export interface AvatarState {
  mode: Mode;
  speaking: boolean;
  amplitude: number;
  mood: Mood;
  toolMood: ToolMood;
}

export function createState(): AvatarState {
  return {
    mode: 'idle',
    speaking: false,
    amplitude: 0,
    mood: null,
    toolMood: null,
  };
}
