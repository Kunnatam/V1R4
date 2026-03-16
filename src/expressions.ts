import { setExpression } from './avatar';

export type BlendShapeTarget = Record<string, number>;

// Rich expression presets — combine multiple blend shapes for nuanced looks
const MOOD_SHAPES: Record<string, BlendShapeTarget> = {
  // Base states
  default:      { neutral: 1.0 },

  // Negative emotions
  error:        { angry: 0.5, squint: 0.3 },
  frustrated:   { angry: 0.3, squint: 0.2, sad: 0.1 },
  annoyed:      { angry: 0.2, squint: 0.15 },

  // Positive emotions — FACS-based: AU6 (cheek raise/eye squint) + AU12 (lip corners)
  // VRM 'happy' bundles AU6+AU12; 'aa' adds AU25 (lip part); 'relaxed' adds warmth
  success:      { happy: 1.0, relaxed: 0.2, aa: 0.08 }, // full Duchenne — max eye squint, lip part
  pleased:      { happy: 0.6, relaxed: 0.25 },           // warm but contained
  amused:       { happy: 0.4, surprised: 0.12 },          // eyes bright with delight
  grateful:     { happy: 0.7, relaxed: 0.3, sad: 0.05 }, // warm with tenderness

  // Alert/surprise
  warn:         { surprised: 0.4 },
  curious:      { surprised: 0.2 },
  intrigued:    { surprised: 0.15, happy: 0.05 },

  // Sad range
  melancholy:   { sad: 0.5, lookDown: 0.3 },
  concerned:    { sad: 0.25, surprised: 0.1 },
  pensive:      { sad: 0.15, lookDown: 0.1, relaxed: 0.1 },

  // Focus/thinking
  focused:      { squint: 0.15, neutral: 0.8 },
  skeptical:    { squint: 0.2, angry: 0.05 },
  contemplative: { lookDown: 0.15, relaxed: 0.2, neutral: 0.7 },

  // Expressive
  smirk:        { happy: 0.15, squint: 0.05 },
  deadpan:      { neutral: 1.0, squint: 0.05 },
  dramatic:     { surprised: 0.3, sad: 0.1 },
};

const TRANSITION_MS = 300;
const CLEAR_TRANSITION_MS = 500;

// Stagger offsets (ms) — brows lead, eyes are baseline, mouth trails
const BROW_KEYS = new Set([
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
]);
const MOUTH_KEYS = new Set([
  'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthOpen', 'mouthPucker', 'jawOpen', 'happy', 'sad', 'angry',
]);
// Brows move 50ms before eyes; mouth moves 100ms after eyes
const BROW_OFFSET_MS = -50;
const MOUTH_OFFSET_MS = 100;

// Overshoot: 5% past target on expression onset, then settle
const OVERSHOOT_FACTOR = 0.05;

let currentShapes: BlendShapeTarget = { neutral: 1.0 };
let targetShapes: BlendShapeTarget = { neutral: 1.0 };
let transitionProgress = 1.0;
let transitionDurationMs = TRANSITION_MS;
let transitionSpeed = 1.0 / TRANSITION_MS;
let isOnset = false; // true = transitioning TO an expression, false = clearing

export function getBlendShapesForMood(mood: string | null): BlendShapeTarget {
  if (!mood || !(mood in MOOD_SHAPES)) return { neutral: 1.0 };
  return { ...MOOD_SHAPES[mood] };
}

export function lerpBlendShapes(
  from: BlendShapeTarget,
  to: BlendShapeTarget,
  t: number,
): BlendShapeTarget {
  const allKeys = new Set([...Object.keys(from), ...Object.keys(to)]);
  const result: BlendShapeTarget = {};
  for (const key of allKeys) {
    const a = from[key] ?? 0;
    const b = to[key] ?? 0;
    const v = a + (b - a) * t;
    if (v > 0.001) result[key] = v;
  }
  return result;
}

// Asymmetric easing — fast reactive start for onset, slow natural fade for release
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeInQuad(t: number): number {
  return t * t;
}

function ease(t: number): number {
  return isOnset ? easeOutCubic(t) : easeInQuad(t);
}

export function setMood(mood: string | null): void {
  currentShapes = getCurrentLerpedShapes();
  targetShapes = getBlendShapesForMood(mood);
  transitionProgress = 0;
  isOnset = mood !== null;
  transitionDurationMs = isOnset ? TRANSITION_MS : CLEAR_TRANSITION_MS;
  transitionSpeed = 1.0 / transitionDurationMs;
}

function getCurrentLerpedShapes(): BlendShapeTarget {
  if (transitionProgress >= 1.0) return { ...targetShapes };
  return lerpBlendShapes(currentShapes, targetShapes, ease(transitionProgress));
}

/** Time-shift a key's progress based on its stagger group. */
function staggerProgress(key: string, rawProgress: number): number {
  let offsetMs = 0;
  if (BROW_KEYS.has(key)) offsetMs = BROW_OFFSET_MS;
  else if (MOUTH_KEYS.has(key)) offsetMs = MOUTH_OFFSET_MS;
  if (offsetMs === 0) return rawProgress;

  const elapsedMs = rawProgress * transitionDurationMs;
  const shifted = Math.max(0, Math.min(transitionDurationMs, elapsedMs - offsetMs));
  return shifted / transitionDurationMs;
}

/** Sine-bump overshoot: peaks ~5% past target mid-transition, settles to 1.0 at end. */
function applyOvershoot(easedT: number): number {
  return easedT + Math.sin(easedT * Math.PI) * OVERSHOOT_FACTOR;
}

export function updateExpressions(deltaMs: number): void {
  if (transitionProgress >= 1.0) return;

  transitionProgress = Math.min(1.0, transitionProgress + deltaMs * transitionSpeed);

  // Clear all current shapes first
  for (const key of Object.keys(currentShapes)) {
    setExpression(key, 0);
  }

  // Per-key interpolation with stagger + overshoot
  const allKeys = new Set([...Object.keys(currentShapes), ...Object.keys(targetShapes)]);
  for (const key of allKeys) {
    const keyProgress = isOnset
      ? staggerProgress(key, transitionProgress)
      : transitionProgress;

    let easedT = ease(keyProgress);

    // Micro-overshoot only during onset, not when fully settled
    if (isOnset && transitionProgress < 1.0) {
      easedT = applyOvershoot(easedT);
    }

    const from = currentShapes[key] ?? 0;
    const to = targetShapes[key] ?? 0;
    const v = from + (to - from) * easedT;
    if (v > 0.001) setExpression(key, v);
  }
}

/** Returns the max weight of emotion blend shapes (0-1) from the current expression state. */
export function getEmotionIntensity(): number {
  const EMOTION_KEYS = ['happy', 'angry', 'sad', 'surprised', 'relaxed'];
  const shapes = getCurrentLerpedShapes();
  let max = 0;
  for (const key of EMOTION_KEYS) {
    const v = shapes[key] ?? 0;
    if (v > max) max = v;
  }
  return max;
}

/** Get all available mood/expression names */
export function getAvailableMoods(): string[] {
  return Object.keys(MOOD_SHAPES);
}
