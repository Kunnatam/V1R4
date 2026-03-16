import { getVRM } from './avatar';
import { createSpring, springDamped, springUnderdamped, SpringState } from './spring';
import { fbm } from './noise';
import type { Mode, Mood } from './state';

// Spring half-lives for body posture transitions
const POSTURE_HL = 0.25;         // body posture changes (seconds)
const POSTURE_FAST_HL = 0.12;   // quick reactions (error flinch, etc.)

interface PostureTarget {
  spineX: number;      // forward/back lean
  spineY: number;      // twist
  chestX: number;      // chest tilt
  headX: number;       // nod
  headY: number;       // turn
  headZ: number;       // tilt
  shoulderL: number;   // left shoulder raise
  shoulderR: number;   // right shoulder raise
  upperArmLX: number;  // left upper arm X rotation (forward/back)
  upperArmRX: number;  // right upper arm X rotation
  lowerArmLZ: number;  // left lower arm Z (bend inward)
  lowerArmRZ: number;  // right lower arm Z
}

const POSTURE_KEYS: (keyof PostureTarget)[] = [
  'spineX', 'spineY', 'chestX',
  'headX', 'headY', 'headZ',
  'shoulderL', 'shoulderR',
  'upperArmLX', 'upperArmRX',
  'lowerArmLZ', 'lowerArmRZ',
];

const ZERO_POSTURE: PostureTarget = {
  spineX: 0, spineY: 0, chestX: 0,
  headX: 0, headY: 0, headZ: 0,
  shoulderL: 0, shoulderR: 0,
  upperArmLX: 0, upperArmRX: 0,
  lowerArmLZ: 0, lowerArmRZ: 0,
};

// Mode postures — base body language per state
const MODE_POSTURES: Record<Mode, PostureTarget> = {
  idle: {
    ...ZERO_POSTURE,
  },
  thinking: {
    ...ZERO_POSTURE,
    headX: 0.1,          // look up
    headZ: 0.12,         // tilt head
    headY: 0.08,         // turn slightly
    chestX: -0.04,       // lean back
    upperArmRX: -0.3,    // right arm comes forward (toward chin)
    lowerArmRZ: 0.4,     // right forearm bends in
    shoulderR: 0.05,     // right shoulder lifts slightly
  },
  speaking: {
    ...ZERO_POSTURE,
    spineX: 0.12,        // lean forward — engaged
    chestX: 0.08,        // chest forward
    headX: -0.06,        // tilt head up — compensate forward lean, look at viewer
    shoulderL: -0.03,    // shoulders relaxed back
    shoulderR: -0.03,
  },
};

// Mood overlays — additive on top of mode posture
const MOOD_POSTURES: Record<string, Partial<PostureTarget>> = {
  error: {
    shoulderL: 0.1,    // tense shoulders up
    shoulderR: 0.1,
    headX: -0.06,      // chin down
    spineX: 0.04,      // forward hunch
  },
  success: {
    spineX: -0.06,     // straighten up / lean back
    chestX: -0.04,     // chest open
    headX: -0.05,      // chin up
  },
  warn: {
    shoulderL: 0.06,
    shoulderR: 0.06,
    headY: 0.1,        // turn (wary)
  },
  melancholy: {
    headX: 0.15,       // head drops noticeably
    spineX: 0.08,      // slouch forward
    chestX: 0.04,
    shoulderL: 0.08,   // shoulders hunch
    shoulderR: 0.08,
  },
};

// Per-channel damping ratios — lighter parts bounce more on mode transitions
// < 1.0 = underdamped (bouncy), 1.0 = critically damped (no bounce)
const DAMPING_RATIOS: Record<keyof PostureTarget, number> = {
  spineX: 0.82,       // spine is heavy — subtle bounce
  spineY: 0.85,
  chestX: 0.78,       // chest follows spine with slightly more bounce
  headX: 0.72,        // head is light — noticeable settle
  headY: 0.72,
  headZ: 0.75,
  shoulderL: 0.80,    // shoulders bounce naturally
  shoulderR: 0.80,
  upperArmLX: 0.65,   // arms are lightest — most visible bounce
  upperArmRX: 0.65,
  lowerArmLZ: 0.60,   // forearms swing most freely
  lowerArmRZ: 0.60,
};

// Spring state for each posture channel
const springs: Record<keyof PostureTarget, SpringState> = {} as any;
for (const key of POSTURE_KEYS) {
  springs[key] = createSpring();
}

let target: PostureTarget = { ...ZERO_POSTURE };

// Speaking energy — subtle oscillation overlay when speaking
let speakingPhase = 0;
let speakingElapsed = 0;
const SPEAKING_SWAY_CYCLE = 3200;

// Speaking arm gestures — visible shoulder/arm motion during speech
const SPEAK_GESTURE_SHOULDER_AMOUNT = 0.06;  // max shoulder raise during emphasis
const SPEAK_GESTURE_ARM_AMOUNT = 0.10;       // max upper arm movement

// Amplitude-reactive nods — quick head dip on loud syllables
const AMP_NOD_THRESHOLD = 0.28;
const AMP_NOD_STRENGTH = 0.08;
const AMP_NOD_COOLDOWN_MS = 120;
let ampNodSpring: SpringState = createSpring();
let ampNodTarget = 0;
let ampNodCooldown = 0;
let prevAmplitude = 0;

// Rhythmic beat-bobs — continuous conversational head cadence during speech
// Multiple layered frequencies create complex, non-repetitive pattern
const BEAT_BOB_PRIMARY_HZ = 3.2;      // ~3.2 bobs/sec — conversational cadence
const BEAT_BOB_SECONDARY_HZ = 1.8;    // slower layer for variety
const BEAT_BOB_TERTIARY_HZ = 0.7;     // phrase-level nod
const BEAT_BOB_PRIMARY_AMOUNT = 0.025;   // primary head dip in radians
const BEAT_BOB_SECONDARY_AMOUNT = 0.015; // secondary layer
const BEAT_BOB_TERTIARY_AMOUNT = 0.035;  // bigger phrase nods

// Gestural head turns — slow drift in Y during speech
const GESTURE_TURN_RANGE = 0.10;
const GESTURE_TURN_MIN_INTERVAL = 2500;
const GESTURE_TURN_MAX_INTERVAL = 5000;
let gestureTurnSpring: SpringState = createSpring();
let gestureTurnTarget = 0;
let gestureTurnTimer = 0;
let gestureTurnNextInterval = 3000;

// Secondary motion — delayed follow from head → chest → spine
const SECONDARY_CHEST_DAMPING = 0.3;
const SECONDARY_SPINE_DAMPING = 0.12;
let secondaryChestSpringY: SpringState = createSpring();
let secondaryChestSpringX: SpringState = createSpring();
let secondarySpineSpringY: SpringState = createSpring();
let secondarySpineSpringX: SpringState = createSpring();
const SECONDARY_HL = 0.15; // spring half-life for secondary motion

function randomGestureInterval(): number {
  return GESTURE_TURN_MIN_INTERVAL + Math.random() * (GESTURE_TURN_MAX_INTERVAL - GESTURE_TURN_MIN_INTERVAL);
}

function randomGestureTurnTarget(): number {
  const sign = Math.random() > 0.5 ? 1 : -1;
  return sign * (0.3 + Math.random() * 0.7) * GESTURE_TURN_RANGE;
}

function addPosture(base: PostureTarget, overlay: Partial<PostureTarget>): PostureTarget {
  return {
    spineX: base.spineX + (overlay.spineX ?? 0),
    spineY: base.spineY + (overlay.spineY ?? 0),
    chestX: base.chestX + (overlay.chestX ?? 0),
    headX: base.headX + (overlay.headX ?? 0),
    headY: base.headY + (overlay.headY ?? 0),
    headZ: base.headZ + (overlay.headZ ?? 0),
    shoulderL: base.shoulderL + (overlay.shoulderL ?? 0),
    shoulderR: base.shoulderR + (overlay.shoulderR ?? 0),
    upperArmLX: base.upperArmLX + (overlay.upperArmLX ?? 0),
    upperArmRX: base.upperArmRX + (overlay.upperArmRX ?? 0),
    lowerArmLZ: base.lowerArmLZ + (overlay.lowerArmLZ ?? 0),
    lowerArmRZ: base.lowerArmRZ + (overlay.lowerArmRZ ?? 0),
  };
}

// Keystroke reaction — subtle spring impulse on typing (toned down 40%)
const KEYSTROKE_HEAD_IMPULSE = 0.45;     // downward head velocity on keystroke
const KEYSTROKE_HEAD_TILT_IMPULSE = 0.27; // lateral head tilt on keystroke
const KEYSTROKE_SHOULDER_IMPULSE = 0.36;  // slight shoulder tension
const KEYSTROKE_COOLDOWN_MS = 80;        // min gap between reactions
let keystrokeCooldown = 0;

let lastLoggedMode: Mode | null = null;

// Anticipation — brief "wind-up" before mode transitions
// Opposite of target direction for ~120ms, then real target
const ANTICIPATION_DURATION = 120; // ms
const ANTICIPATION_STRENGTH = 0.4; // how much to wind up (fraction of delta)
let anticipationTimer = 0;
let anticipationTarget: PostureTarget = { ...ZERO_POSTURE };
let prevTarget: PostureTarget = { ...ZERO_POSTURE };
let lastModeForAnticipation: Mode | null = null;

/** Trigger a subtle bounce reaction to a keystroke */
export function triggerKeystrokeReaction(): void {
  if (keystrokeCooldown > 0) return;
  keystrokeCooldown = KEYSTROKE_COOLDOWN_MS;
  // ±30% jitter so each keystroke feels slightly different
  const jitter = 0.7 + Math.random() * 0.6;
  springs.headX.vel += KEYSTROKE_HEAD_IMPULSE * jitter;
  // Random left-right tilt
  const tiltDir = Math.random() > 0.5 ? 1 : -1;
  springs.headZ.vel += KEYSTROKE_HEAD_TILT_IMPULSE * jitter * tiltDir;
  // Occasional deeper nod (~20% chance) — like reading/acknowledging
  if (Math.random() < 0.2) {
    springs.headX.vel += KEYSTROKE_HEAD_IMPULSE * 1.8;
  }
  // Alternate shoulders with jitter
  const side = Math.random() > 0.5 ? 1 : -1;
  const sJitter = 0.7 + Math.random() * 0.6;
  springs.shoulderL.vel += KEYSTROKE_SHOULDER_IMPULSE * sJitter * (side > 0 ? 1 : 0.3);
  springs.shoulderR.vel += KEYSTROKE_SHOULDER_IMPULSE * sJitter * (side > 0 ? 0.3 : 1);
}

export function updateBody(deltaMs: number, mode: Mode, mood: Mood, amplitude: number): void {
  const vrm = getVRM();
  if (!vrm?.humanoid) return;
  const dt = deltaMs / 1000;

  // Tick keystroke cooldown
  keystrokeCooldown = Math.max(0, keystrokeCooldown - deltaMs);

  if (mode !== lastLoggedMode) {
    console.log(`[V1R4] Body mode: ${mode}, mood: ${mood}`);
    lastLoggedMode = mode;
  }

  // Compute target: mode base + mood overlay
  const modePosture = MODE_POSTURES[mode] ?? ZERO_POSTURE;
  const moodOverlay = mood && MOOD_POSTURES[mood] ? MOOD_POSTURES[mood] : {};
  const realTarget = addPosture(modePosture, moodOverlay);

  // Trigger anticipation on mode change
  if (mode !== lastModeForAnticipation && lastModeForAnticipation !== null) {
    anticipationTimer = ANTICIPATION_DURATION;
    // Wind-up: move briefly in the opposite direction of the change
    for (const key of POSTURE_KEYS) {
      const delta = realTarget[key] - prevTarget[key];
      anticipationTarget[key] = prevTarget[key] - delta * ANTICIPATION_STRENGTH;
    }
  }
  lastModeForAnticipation = mode;

  // During anticipation, use the wind-up target; otherwise use real target
  if (anticipationTimer > 0) {
    anticipationTimer -= deltaMs;
    target = anticipationTimer > 0 ? anticipationTarget : realTarget;
  } else {
    target = realTarget;
  }
  prevTarget = realTarget;

  // Determine half-life — faster for reactive moods (error, warn)
  const hl = (mood === 'error' || mood === 'warn') ? POSTURE_FAST_HL : POSTURE_HL;

  // Underdamped spring posture interpolation — bouncy settle on mode transitions
  for (const key of POSTURE_KEYS) {
    springs[key] = springUnderdamped(springs[key], target[key], hl, DAMPING_RATIOS[key], dt);
  }

  // Speaking energy: body sway + beat-bobs + amplitude nods
  let speakingSway = 0;
  let speakingNod = 0;
  let beatBob = 0;
  let gestureTurnOffset = 0;
  if (mode === 'speaking') {
    speakingPhase += (deltaMs / SPEAKING_SWAY_CYCLE) * Math.PI * 2;
    speakingElapsed += dt;
    const energy = Math.min(amplitude * 2.0, 1.0);
    speakingSway = Math.sin(speakingPhase) * 0.05 * energy;
    speakingNod = Math.sin(speakingPhase * 1.7) * 0.03 * energy;

    // Rhythmic beat-bobs: layered sine waves with irrational ratios → non-repeating
    const t = speakingElapsed;
    beatBob = (
      Math.sin(t * BEAT_BOB_PRIMARY_HZ * Math.PI * 2) * BEAT_BOB_PRIMARY_AMOUNT +
      Math.sin(t * BEAT_BOB_SECONDARY_HZ * Math.PI * 2 + 0.7) * BEAT_BOB_SECONDARY_AMOUNT +
      Math.sin(t * BEAT_BOB_TERTIARY_HZ * Math.PI * 2 + 1.4) * BEAT_BOB_TERTIARY_AMOUNT
    ) * energy;

    // --- Amplitude-reactive nods (spring-based) ---
    ampNodCooldown = Math.max(0, ampNodCooldown - deltaMs);
    const ampDelta = amplitude - prevAmplitude;
    if (ampDelta > 0.05 && amplitude > AMP_NOD_THRESHOLD && ampNodCooldown <= 0) {
      ampNodTarget = AMP_NOD_STRENGTH * Math.min(amplitude * 2, 1.0);
      ampNodCooldown = AMP_NOD_COOLDOWN_MS;
    } else if (ampNodCooldown <= 0) {
      ampNodTarget = 0;
    }
    // Nod spring: snappy attack (0.04s), gentle release (0.15s)
    const nodHL = ampNodTarget > ampNodSpring.pos ? 0.04 : 0.15;
    ampNodSpring = springDamped(ampNodSpring, ampNodTarget, nodHL, dt);

    // --- Gestural head turns ---
    gestureTurnTimer += deltaMs;
    if (gestureTurnTimer >= gestureTurnNextInterval) {
      gestureTurnTarget = randomGestureTurnTarget();
      gestureTurnNextInterval = randomGestureInterval();
      gestureTurnTimer = 0;
    }
    gestureTurnSpring = springDamped(gestureTurnSpring, gestureTurnTarget, 0.3, dt);
    gestureTurnOffset = gestureTurnSpring.pos;
  } else {
    // Not speaking — decay reactive state back to zero
    ampNodSpring = springDamped(ampNodSpring, 0, 0.2, dt);
    gestureTurnSpring = springDamped(gestureTurnSpring, 0, 0.4, dt);
    gestureTurnTimer = 0;
    ampNodCooldown = 0;
  }
  prevAmplitude = amplitude;

  // Apply to bones (additive — idle.ts handles its own head micro-movement)
  const head = vrm.humanoid.getNormalizedBoneNode('head');
  if (head) {
    head.rotation.x += -springs.headX.pos - ampNodSpring.pos - beatBob;
    head.rotation.y += springs.headY.pos + gestureTurnOffset;
    head.rotation.z += springs.headZ.pos;

    // Secondary motion — chest and spine follow head with spring delay
    const headY = head.rotation.y;
    const headX = head.rotation.x;

    secondaryChestSpringY = springDamped(secondaryChestSpringY, headY * SECONDARY_CHEST_DAMPING, SECONDARY_HL, dt);
    secondaryChestSpringX = springDamped(secondaryChestSpringX, headX * SECONDARY_CHEST_DAMPING, SECONDARY_HL, dt);
    secondarySpineSpringY = springDamped(secondarySpineSpringY, headY * SECONDARY_SPINE_DAMPING, SECONDARY_HL * 1.5, dt);
    secondarySpineSpringX = springDamped(secondarySpineSpringX, headX * SECONDARY_SPINE_DAMPING, SECONDARY_HL * 1.5, dt);
  }

  // Additive — idle.ts sets breathing base, we layer posture on top
  const chest = vrm.humanoid.getNormalizedBoneNode('chest');
  if (chest) {
    chest.rotation.x += -springs.chestX.pos - speakingNod + secondaryChestSpringX.pos;
    chest.rotation.y = secondaryChestSpringY.pos;
  }

  const spine = vrm.humanoid.getNormalizedBoneNode('spine');
  if (spine) {
    spine.rotation.y = springs.spineY.pos + speakingSway + secondarySpineSpringY.pos;
    spine.rotation.z = 0;
    spine.rotation.x += -springs.spineX.pos + secondarySpineSpringX.pos;
  }

  // --- Speaking arm gestures (noise-driven shoulder/arm emphasis) ---
  let speakShoulderL = 0, speakShoulderR = 0;
  let speakArmLX = 0, speakArmRX = 0;
  if (mode === 'speaking') {
    const t = speakingElapsed;
    const energy = Math.min(amplitude * 2.0, 1.0);
    // Asymmetric shoulder raises — different noise seeds per side
    speakShoulderL = fbm(t * 0.4 + 1700, 2) * SPEAK_GESTURE_SHOULDER_AMOUNT * energy;
    speakShoulderR = fbm(t * 0.35 + 1800, 2) * SPEAK_GESTURE_SHOULDER_AMOUNT * energy;
    // Subtle upper arm forward/back on emphasis
    speakArmLX = fbm(t * 0.25 + 1900, 2) * SPEAK_GESTURE_ARM_AMOUNT * energy;
    speakArmRX = fbm(t * 0.3 + 2000, 2) * SPEAK_GESTURE_ARM_AMOUNT * energy;
  }

  const leftShoulder = vrm.humanoid.getNormalizedBoneNode('leftShoulder');
  if (leftShoulder) {
    leftShoulder.rotation.z += springs.shoulderL.pos + speakShoulderL;
  }

  const rightShoulder = vrm.humanoid.getNormalizedBoneNode('rightShoulder');
  if (rightShoulder) {
    rightShoulder.rotation.z += springs.shoulderR.pos + speakShoulderR;
  }

  // --- Arm posture (thinking pose, speaking gestures, etc.) ---
  const leftUpperArm = vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
  if (leftUpperArm) {
    leftUpperArm.rotation.x += springs.upperArmLX.pos + speakArmLX;
  }
  const rightUpperArm = vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
  if (rightUpperArm) {
    rightUpperArm.rotation.x += springs.upperArmRX.pos + speakArmRX;
  }
  const leftLowerArm = vrm.humanoid.getNormalizedBoneNode('leftLowerArm');
  if (leftLowerArm && springs.lowerArmLZ.pos !== 0) {
    leftLowerArm.rotation.z += springs.lowerArmLZ.pos;
  }
  const rightLowerArm = vrm.humanoid.getNormalizedBoneNode('rightLowerArm');
  if (rightLowerArm && springs.lowerArmRZ.pos !== 0) {
    rightLowerArm.rotation.z += springs.lowerArmRZ.pos;
  }
}

export function resetBody(): void {
  for (const key of POSTURE_KEYS) {
    springs[key] = createSpring();
  }
  target = { ...ZERO_POSTURE };
  anticipationTimer = 0;
  anticipationTarget = { ...ZERO_POSTURE };
  prevTarget = { ...ZERO_POSTURE };
  lastModeForAnticipation = null;
  speakingPhase = 0;
  speakingElapsed = 0;
  ampNodSpring = createSpring();
  ampNodTarget = 0;
  ampNodCooldown = 0;
  prevAmplitude = 0;
  gestureTurnSpring = createSpring();
  gestureTurnTarget = 0;
  gestureTurnTimer = 0;
  gestureTurnNextInterval = 3000;
  secondaryChestSpringY = createSpring();
  secondaryChestSpringX = createSpring();
  secondarySpineSpringY = createSpring();
  secondarySpineSpringX = createSpring();
}
