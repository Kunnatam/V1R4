import { setExpression, getVRM, REST_ARM_Z, REST_FOREARM_Z } from './avatar';
import { getEmotionIntensity } from './expressions';
import { fbm } from './noise';
import { createSpring, springDamped, SpringState } from './spring';

// Blink config — occasional double blinks for realism
const BLINK_MIN_INTERVAL = 2500;
const BLINK_MAX_INTERVAL = 7000;
// Asymmetric blink timing — Disney Research finding:
// close is fast (75ms), hold (40ms), open is slow with long tail (200ms)
const BLINK_CLOSE_MS = 75;
const BLINK_HOLD_MS = 40;
const BLINK_OPEN_MS = 200;
const BLINK_TOTAL_MS = BLINK_CLOSE_MS + BLINK_HOLD_MS + BLINK_OPEN_MS;
const DOUBLE_BLINK_CHANCE = 0.2;
const DOUBLE_BLINK_GAP = 120;

// Breathing config — whole body breathes with phase propagation
const BREATHE_PRIMARY_CYCLE = 4200;
const BREATHE_CHEST_X = 0.012;           // chest tilts back on inhale
const BREATHE_CHEST_SCALE = 0.003;       // ribcage expansion
const BREATHE_SPINE_AMOUNT = 0.006;      // spine straightens on inhale
const BREATHE_SHOULDER_AMOUNT = 0.008;   // shoulders rise on inhale
const BREATHE_SHOULDER_PHASE = 0.3;      // shoulders lag behind chest (radians)
const BREATHE_HEAD_AMOUNT = 0.004;       // head micro-nod backward
const BREATHE_NECK_AMOUNT = 0.003;       // neck slight extension

// Asymmetric idle pose — one shoulder slightly higher, slight lean
// Breaks perfect symmetry which makes characters feel alive (Pixar principle)
const ASYM_SHOULDER_OFFSET = 0.008;      // right shoulder slightly higher
const ASYM_HEAD_TILT = 0.015;            // slight head tilt
const ASYM_HIP_LEAN = 0.004;            // slight weight on one side

// Head tilt holds — occasionally hold a tilt for a few seconds (like thinking)
const TILT_HOLD_MIN_INTERVAL = 8000;
const TILT_HOLD_MAX_INTERVAL = 20000;
const TILT_HOLD_DURATION = 2000;         // how long to hold
const TILT_HOLD_AMOUNT = 0.06;           // max tilt in radians (~3.5°)

// Saccade config — fast snap then slow settle (like real eyes)
const SACCADE_MIN_INTERVAL = 2000;
const SACCADE_MAX_INTERVAL = 6000;
const SACCADE_RANGE_X = 0.35;
const SACCADE_RANGE_Y = 0.2;

// Mouse tracking config — using spring half-lives for natural feel
const MOUSE_EYE_STRENGTH_X = 0.7;     // max eye X from mouse
const MOUSE_EYE_STRENGTH_Y = 0.45;    // max eye Y from mouse
const MOUSE_HEAD_STRENGTH_X = 0.30;   // max head Y rotation (radians, ~17°)
const MOUSE_HEAD_STRENGTH_Y = 0.18;   // max head X rotation (radians, ~10°)
const MOUSE_SACCADE_BLEND = 0.12;     // saccade noise layered on mouse tracking

// Spring half-lives (seconds) — how fast each system settles
const EYE_SPRING_HL = 0.06;           // eyes snap fast
const SACCADE_SNAP_HL = 0.03;         // saccade snap is very fast
const SACCADE_SETTLE_HL = 0.3;        // saccade settle is floaty
const HEAD_SPRING_HL = 0.18;          // head follows smoothly
const TILT_SPRING_HL = 0.4;           // tilt hold eases in gently

// Gaze-breaking — occasionally look away briefly then back (natural social behavior)
const GAZE_BREAK_MIN_INTERVAL = 5000;
const GAZE_BREAK_MAX_INTERVAL = 15000;
const GAZE_BREAK_DURATION = 400;       // how long to look away (ms)
const GAZE_BREAK_AMOUNT = 0.4;         // how far to look away (normalized)

// Contrapposto weight shift — S-curve posture shift between legs
// Makes avatar look like they're standing with weight, not hovering
const CONTRA_SHIFT_MIN_INTERVAL = 5000;
const CONTRA_SHIFT_MAX_INTERVAL = 15000;
const CONTRA_HL = 0.6;                  // slow, ponderous — weight is heavy
const CONTRA_HIP_Z = 0.035;             // hip tilt toward weight side
const CONTRA_SPINE_Z = 0.021;           // counter-tilt (60% of hip, opposite)
const CONTRA_CHEST_Z = 0.014;           // further counter-tilt
const CONTRA_NECK_Z = 0.01;             // compensate to keep head level

// Micro-fidgets — periodic discrete animations that break the continuous noise loop
// Real humans make small postural adjustments every few seconds
const FIDGET_MIN_INTERVAL = 4000;
const FIDGET_MAX_INTERVAL = 10000;

type FidgetType = 'weightShift' | 'deepBreath' | 'postureAdjust' | 'shoulderSettle';

interface FidgetDef {
  duration: number;  // ms
  // Spring targets at peak (will ramp up then release)
  hipZ?: number;
  spineX?: number;
  shoulderL?: number;
  shoulderR?: number;
  chestScale?: number; // multiplier on breathing
}

const FIDGET_DEFS: Record<FidgetType, FidgetDef> = {
  weightShift: {
    duration: 1800,
    hipZ: 0.025,  // lean to one side (~1.4°)
  },
  deepBreath: {
    duration: 2400,
    chestScale: 2.5, // amplified breathing
    shoulderL: 0.01,
    shoulderR: 0.01,
  },
  postureAdjust: {
    duration: 1200,
    spineX: -0.03, // straighten up
  },
  shoulderSettle: {
    duration: 1000,
    shoulderL: 0.015,
    shoulderR: -0.008, // asymmetric for naturalness
  },
};

const FIDGET_TYPES: FidgetType[] = ['weightShift', 'deepBreath', 'postureAdjust', 'shoulderSettle'];

// State
let blinkTimer = randomRange(BLINK_MIN_INTERVAL, BLINK_MAX_INTERVAL);
let blinkProgress = -1;
let doubleBlink = false;
let doubleBlinkGap = -1;

let breathePrimaryPhase = 0;
let saccadeTimer = randomRange(SACCADE_MIN_INTERVAL, SACCADE_MAX_INTERVAL);
let saccadeTargetX = 0;
let saccadeTargetY = 0;
let saccadeJustMoved = false;
let saccadeSettleTimer = 0;

// Spring-based tracking state (replaces raw lerps)
let eyeSpringX: SpringState = createSpring();
let eyeSpringY: SpringState = createSpring();
let headSpringX: SpringState = createSpring();
let headSpringY: SpringState = createSpring();
let saccadeSpringX: SpringState = createSpring();
let saccadeSpringY: SpringState = createSpring();
let tiltSpring: SpringState = createSpring();

let elapsed = 0;

// Head tilt hold state
let tiltHoldTimer = randomRange(TILT_HOLD_MIN_INTERVAL, TILT_HOLD_MAX_INTERVAL);
let tiltHoldActive = false;
let tiltHoldProgress = 0;
let tiltHoldTarget = 0;

// Mouse tracking state — normalized -1 to 1
let mouseNormX = 0;
let mouseNormY = 0;


// Contrapposto state
let contraSpring: SpringState = createSpring();
let contraTimer = randomRange(CONTRA_SHIFT_MIN_INTERVAL, CONTRA_SHIFT_MAX_INTERVAL);
let contraTarget = 0; // -1, 0, or 1

// Micro-fidget state
let fidgetTimer = randomRange(FIDGET_MIN_INTERVAL, FIDGET_MAX_INTERVAL);
let fidgetActive = false;
let fidgetProgress = 0;
let fidgetDuration = 0;
let fidgetSign = 1; // randomize direction
let fidgetHipZ: SpringState = createSpring();
let fidgetSpineX: SpringState = createSpring();
let fidgetShoulderL: SpringState = createSpring();
let fidgetShoulderR: SpringState = createSpring();
let fidgetBreathScale = 1.0;
let currentFidget: FidgetDef | null = null;

// Gaze-breaking state
let gazeBreakTimer = randomRange(GAZE_BREAK_MIN_INTERVAL, GAZE_BREAK_MAX_INTERVAL);
let gazeBreakActive = false;
let gazeBreakProgress = 0;
let gazeBreakOffsetX = 0;
let gazeBreakOffsetY = 0;

// Typing awareness — gaze follows typing activity
const TYPING_GAZE_DOWN = -0.10;          // subtle downward glance when typing
const TYPING_GAZE_HL = 0.25;            // spring HL for gaze shift
const TYPING_TIMEOUT_MS = 800;          // stop "typing" gaze after 800ms idle
let lastKeystrokeTime = 0;
let typingGazeSpring: SpringState = createSpring();

// Boredom — long silence triggers increased fidgets + gaze drift
const BOREDOM_ONSET_MS = 30000;         // 30s without keystrokes → bored
const BOREDOM_DEEP_MS = 60000;          // 60s → deeply bored
const BOREDOM_GAZE_DRIFT = 0.5;         // how far eyes wander when bored
const BOREDOM_SIGH_INTERVAL = 12000;    // deep breath every 12s when bored
let boredGazeSpringX: SpringState = createSpring();
let boredGazeSpringY: SpringState = createSpring();
let boredGazeTimer = 0;
let boredGazeTargetX = 0;
let boredGazeTargetY = 0;
let boredSighTimer = 0;

/** Call from main.ts on mousemove to update cursor position */
export function setMousePosition(normX: number, normY: number): void {
  mouseNormX = normX;
  mouseNormY = normY;
}


/** Notify that a keystroke was detected — updates typing awareness + resets boredom */
export function notifyKeystroke(): void {
  lastKeystrokeTime = performance.now();
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Asymmetric blink curve — fast snap close, slow natural open */
function blinkValue(progress: number): number {
  if (progress < BLINK_CLOSE_MS) {
    // Close: quadratic ease-in (accelerating snap)
    const t = progress / BLINK_CLOSE_MS;
    return t * t;
  } else if (progress < BLINK_CLOSE_MS + BLINK_HOLD_MS) {
    // Hold closed
    return 1.0;
  } else {
    // Open: cubic ease-out (fast initial open, long slow tail)
    const t = (progress - BLINK_CLOSE_MS - BLINK_HOLD_MS) / BLINK_OPEN_MS;
    return 1.0 - (1.0 - Math.pow(1.0 - t, 3));
  }
}

let prevMode = 'idle';

/** Trigger a blink from external code (e.g., mood changes) */
export function triggerBlink(): void {
  if (blinkProgress < 0 && doubleBlinkGap < 0) {
    startBlink();
  }
}

/** Start a blink with eye wobble impulse */
function startBlink(): void {
  blinkProgress = 0;
  // Eye wobble on blink — Warudo-style "eye wiggle"
  // Tiny random horizontal impulse on eye springs for natural jitter
  const wobble = (Math.random() - 0.5) * 0.06;
  eyeSpringX.vel += wobble * 8; // velocity impulse
  saccadeSpringX.vel += wobble * 4;
}

export function updateIdle(deltaMs: number, isSpeaking: boolean, mode: string = 'idle', mood: string | null = null): void {
  elapsed += deltaMs;
  const vrm = getVRM();
  const dt = deltaMs / 1000; // spring system uses seconds

  // Trigger blink on mode change — natural human reaction to state transitions
  if (mode !== prevMode) {
    if (blinkProgress < 0 && doubleBlinkGap < 0) {
      startBlink(); // start a blink
    }
    prevMode = mode;
  }

  // Emotion-reactive multipliers — mood affects idle behavior quality
  const moodTension = (mood === 'error' || mood === 'frustrated') ? 1.5 :
                       (mood === 'warn' || mood === 'annoyed') ? 1.25 :
                       (mood === 'melancholy' || mood === 'sad') ? 0.7 :
                       (mood === 'success' || mood === 'pleased') ? 0.85 : 1.0;
  const moodBreathSpeed = (mood === 'error' || mood === 'warn') ? 1.3 :
                           (mood === 'melancholy') ? 0.8 : 1.0;

  // Mode-aware speed multipliers — visible, not subtle
  const breatheSpeed = (mode === 'speaking' ? 1.4 : mode === 'thinking' ? 0.7 : 1.0) * moodBreathSpeed;
  const headAmplitude = (mode === 'speaking' ? 2.0 : mode === 'thinking' ? 0.6 : 1.2) * (moodTension > 1.0 ? 1.2 : 1.0);
  const bodyAmplitude = (mode === 'speaking' ? 1.0 : mode === 'thinking' ? 0.4 : 1.0) * moodTension;
  const noiseTime = elapsed / 1000;

  // --- Blinking (with occasional double blinks) ---
  const emotionIntensity = getEmotionIntensity();
  const blinkScale = 1 - emotionIntensity * 0.5;

  if (blinkProgress >= 0) {
    blinkProgress += deltaMs;
    if (blinkProgress < BLINK_TOTAL_MS) {
      const bv = blinkValue(blinkProgress) * blinkScale;
      setExpression('blink', bv);
    } else {
      setExpression('blink', 0);
      blinkProgress = -1;
      if (doubleBlink) {
        doubleBlink = false;
        doubleBlinkGap = DOUBLE_BLINK_GAP;
      } else {
        // Emotion-reactive blink rate: stressed = faster, relaxed = slower
        const blinkRateMultiplier = mode === 'speaking' ? 0.8 : // slightly faster when talking
          emotionIntensity > 0.3 ? 0.7 : 1.0; // faster when emotional
        blinkTimer = randomRange(
          BLINK_MIN_INTERVAL * blinkRateMultiplier,
          BLINK_MAX_INTERVAL * blinkRateMultiplier
        );
      }
    }
  } else if (doubleBlinkGap >= 0) {
    doubleBlinkGap -= deltaMs;
    if (doubleBlinkGap <= 0) {
      doubleBlinkGap = -1;
      startBlink();
      blinkTimer = randomRange(BLINK_MIN_INTERVAL, BLINK_MAX_INTERVAL);
    }
  } else {
    blinkTimer -= deltaMs;
    if (blinkTimer <= 0) {
      startBlink();
      doubleBlink = Math.random() < DOUBLE_BLINK_CHANCE;
    }
  }

  // --- Breathing (whole body with phase propagation) ---
  // Breathing rate varies slightly — not a perfect metronome
  const breatheRateVar = 1.0 + fbm(noiseTime * 0.05 + 3000, 2) * 0.15; // ±15% rate variation
  breathePrimaryPhase += (deltaMs / BREATHE_PRIMARY_CYCLE) * Math.PI * 2 * breatheSpeed * breatheRateVar;
  const breatheDepth = 0.003 + fbm(noiseTime * 0.08 + 300, 2) * 0.002;
  const breatheAmount = Math.sin(breathePrimaryPhase) * breatheDepth;
  const breatheCycle = Math.sin(breathePrimaryPhase);
  // Phase-offset shoulder breathing — shoulders lag behind chest
  const breatheShoulder = Math.sin(breathePrimaryPhase - BREATHE_SHOULDER_PHASE);
  // Shoulder position rise only on inhale (max(0, ...))
  const shoulderInhaleRise = Math.max(0, breatheShoulder) * 0.002;

  // --- Head tilt holds (occasional held tilt, like pondering) ---
  if (!tiltHoldActive) {
    tiltHoldTimer -= deltaMs;
    if (tiltHoldTimer <= 0) {
      tiltHoldActive = true;
      tiltHoldProgress = 0;
      tiltHoldTarget = (Math.random() > 0.5 ? 1 : -1) * (0.5 + Math.random() * 0.5) * TILT_HOLD_AMOUNT;
    }
  } else {
    tiltHoldProgress += deltaMs;
    if (tiltHoldProgress >= TILT_HOLD_DURATION) {
      tiltHoldActive = false;
      tiltHoldTarget = 0;
      tiltHoldTimer = randomRange(TILT_HOLD_MIN_INTERVAL, TILT_HOLD_MAX_INTERVAL);
    }
  }
  // Spring-based tilt hold (replaces raw lerp)
  tiltSpring = springDamped(tiltSpring, tiltHoldTarget, TILT_SPRING_HL, dt);

  // --- Micro-fidgets (periodic discrete animations in idle) ---
  // Tense moods → more frequent fidgeting; calm → less
  const fidgetRateScale = moodTension > 1.2 ? 0.5 : moodTension < 0.8 ? 1.5 : 1.0;
  if (mode === 'idle') {
    if (!fidgetActive) {
      fidgetTimer -= deltaMs;
      if (fidgetTimer <= 0) {
        fidgetActive = true;
        fidgetProgress = 0;
        const type = FIDGET_TYPES[Math.floor(Math.random() * FIDGET_TYPES.length)];
        currentFidget = FIDGET_DEFS[type];
        fidgetDuration = currentFidget.duration;
        fidgetSign = Math.random() > 0.5 ? 1 : -1;
      }
    } else {
      fidgetProgress += deltaMs;
      if (fidgetProgress >= fidgetDuration) {
        fidgetActive = false;
        currentFidget = null;
        fidgetTimer = randomRange(FIDGET_MIN_INTERVAL * fidgetRateScale, FIDGET_MAX_INTERVAL * fidgetRateScale);
      }
    }
  }

  // Fidget spring targets: ramp up in first half, release in second half
  const fidgetPhase = currentFidget && fidgetActive
    ? (fidgetProgress < fidgetDuration * 0.4 ? fidgetProgress / (fidgetDuration * 0.4) : // ramp up
       fidgetProgress < fidgetDuration * 0.7 ? 1.0 : // hold
       1.0 - (fidgetProgress - fidgetDuration * 0.7) / (fidgetDuration * 0.3)) // release
    : 0;
  const fHL = 0.12; // fidget spring half-life — responsive
  fidgetHipZ = springDamped(fidgetHipZ, (currentFidget?.hipZ ?? 0) * fidgetPhase * fidgetSign, fHL, dt);
  fidgetSpineX = springDamped(fidgetSpineX, (currentFidget?.spineX ?? 0) * fidgetPhase, fHL, dt);
  fidgetShoulderL = springDamped(fidgetShoulderL, (currentFidget?.shoulderL ?? 0) * fidgetPhase, fHL, dt);
  fidgetShoulderR = springDamped(fidgetShoulderR, (currentFidget?.shoulderR ?? 0) * fidgetPhase, fHL, dt);
  fidgetBreathScale = 1.0 + ((currentFidget?.chestScale ?? 1.0) - 1.0) * fidgetPhase;

  // --- Contrapposto weight shift (S-curve standing posture) ---
  if (mode === 'idle') {
    contraTimer -= deltaMs;
    if (contraTimer <= 0) {
      contraTarget = [-1, 0, 1][Math.floor(Math.random() * 3)];
      contraTimer = randomRange(CONTRA_SHIFT_MIN_INTERVAL, CONTRA_SHIFT_MAX_INTERVAL);
    }
  }
  contraSpring = springDamped(contraSpring, mode === 'idle' ? contraTarget : 0, CONTRA_HL, dt);
  const cw = contraSpring.pos; // weight shift factor: -1 to 1

  if (vrm?.humanoid) {
    const chest = vrm.humanoid.getNormalizedBoneNode('chest');
    if (chest) {
      chest.scale.y = 1.0 + breatheCycle * BREATHE_CHEST_SCALE * fidgetBreathScale;
      chest.rotation.x = -breatheCycle * BREATHE_CHEST_X * fidgetBreathScale; // tilt back on inhale
      chest.rotation.z = cw * -CONTRA_CHEST_Z;
    }
    // Upper chest expands more visibly — ribcage
    const upperChest = vrm.humanoid.getNormalizedBoneNode('upperChest');
    if (upperChest) {
      upperChest.rotation.x = -breatheCycle * BREATHE_CHEST_X * 0.5 * fidgetBreathScale;
      upperChest.scale.y = 1.0 + breatheAmount * 1.5 * fidgetBreathScale;
    }

    const spine = vrm.humanoid.getNormalizedBoneNode('spine');
    if (spine) {
      spine.rotation.x = breatheCycle * BREATHE_SPINE_AMOUNT + fidgetSpineX.pos;
      spine.rotation.z = cw * -CONTRA_SPINE_Z; // counter-tilt
    }

    // --- Weight shifting (noise-driven hip/spine sway + contrapposto + lean + fidget) ---
    const hips = vrm.humanoid.getNormalizedBoneNode('hips');
    if (hips) {
      hips.rotation.z = fbm(noiseTime * 0.04 + 400, 2) * 0.015 * bodyAmplitude + ASYM_HIP_LEAN + fidgetHipZ.pos + cw * CONTRA_HIP_Z;
      hips.rotation.x = fbm(noiseTime * 0.03 + 500, 2) * 0.008 * bodyAmplitude;
    }

    // --- Shoulders: phase-offset breathing + noise + asymmetry + fidget ---
    const leftShoulder = vrm.humanoid.getNormalizedBoneNode('leftShoulder');
    const rightShoulder = vrm.humanoid.getNormalizedBoneNode('rightShoulder');
    if (leftShoulder) {
      leftShoulder.rotation.z =
        fbm(noiseTime * 0.05 + 600, 2) * 0.01 * bodyAmplitude
        + breatheShoulder * BREATHE_SHOULDER_AMOUNT * fidgetBreathScale
        + fidgetShoulderL.pos;
      leftShoulder.position.y = shoulderInhaleRise * fidgetBreathScale;
    }
    if (rightShoulder) {
      rightShoulder.rotation.z =
        fbm(noiseTime * 0.05 + 700, 2) * 0.01 * bodyAmplitude
        + breatheShoulder * BREATHE_SHOULDER_AMOUNT * fidgetBreathScale
        + ASYM_SHOULDER_OFFSET
        + fidgetShoulderR.pos;
      rightShoulder.position.y = shoulderInhaleRise * fidgetBreathScale;
    }

    // --- Upper arm subtle sway ---
    const leftUpperArm = vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
    const rightUpperArm = vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
    if (leftUpperArm) {
      leftUpperArm.rotation.x = fbm(noiseTime * 0.035 + 800, 2) * 0.02 * bodyAmplitude;
      leftUpperArm.rotation.z = REST_ARM_Z + fbm(noiseTime * 0.03 + 900, 2) * 0.015 * bodyAmplitude;
    }
    if (rightUpperArm) {
      rightUpperArm.rotation.x = fbm(noiseTime * 0.035 + 1000, 2) * 0.02 * bodyAmplitude;
      rightUpperArm.rotation.z = -REST_ARM_Z + fbm(noiseTime * 0.03 + 1100, 2) * -0.015 * bodyAmplitude;
    }

    // --- Lower arm subtle sway (elbows gently shift) ---
    const leftLowerArm = vrm.humanoid.getNormalizedBoneNode('leftLowerArm');
    const rightLowerArm = vrm.humanoid.getNormalizedBoneNode('rightLowerArm');
    if (leftLowerArm) {
      leftLowerArm.rotation.z = REST_FOREARM_Z + fbm(noiseTime * 0.025 + 2300, 2) * 0.03 * bodyAmplitude;
      leftLowerArm.rotation.y = fbm(noiseTime * 0.02 + 2400, 2) * 0.015 * bodyAmplitude;
    }
    if (rightLowerArm) {
      rightLowerArm.rotation.z = -REST_FOREARM_Z + fbm(noiseTime * 0.025 + 2500, 2) * -0.03 * bodyAmplitude;
      rightLowerArm.rotation.y = fbm(noiseTime * 0.02 + 2600, 2) * -0.015 * bodyAmplitude;
    }
  }

  // --- Eye saccades (spring-based — fast snap, natural settle) ---
  saccadeTimer -= deltaMs;
  if (saccadeTimer <= 0) {
    saccadeTargetX = (Math.random() - 0.5) * SACCADE_RANGE_X * 2;
    saccadeTargetY = (Math.random() - 0.5) * SACCADE_RANGE_Y * 2;
    saccadeTimer = randomRange(SACCADE_MIN_INTERVAL, SACCADE_MAX_INTERVAL);
    saccadeJustMoved = true;
    saccadeSettleTimer = 200;
  }

  const saccadeHL = saccadeJustMoved ? SACCADE_SNAP_HL : SACCADE_SETTLE_HL;
  saccadeSpringX = springDamped(saccadeSpringX, saccadeTargetX, saccadeHL, dt);
  saccadeSpringY = springDamped(saccadeSpringY, saccadeTargetY, saccadeHL, dt);

  if (saccadeJustMoved) {
    saccadeSettleTimer -= deltaMs;
    if (saccadeSettleTimer <= 0) saccadeJustMoved = false;
  }

  // --- Gaze-breaking (briefly look away then back — social realism) ---
  if (!gazeBreakActive) {
    gazeBreakTimer -= deltaMs;
    if (gazeBreakTimer <= 0 && !isSpeaking) {
      gazeBreakActive = true;
      gazeBreakProgress = 0;
      // Look slightly away in a random direction
      const angle = Math.random() * Math.PI * 2;
      gazeBreakOffsetX = Math.cos(angle) * GAZE_BREAK_AMOUNT;
      gazeBreakOffsetY = Math.sin(angle) * GAZE_BREAK_AMOUNT * 0.5; // less vertical
    }
  } else {
    gazeBreakProgress += deltaMs;
    if (gazeBreakProgress >= GAZE_BREAK_DURATION) {
      gazeBreakActive = false;
      gazeBreakOffsetX = 0;
      gazeBreakOffsetY = 0;
      gazeBreakTimer = randomRange(GAZE_BREAK_MIN_INTERVAL, GAZE_BREAK_MAX_INTERVAL);
    }
  }

  // --- Typing awareness — look down when K is typing ---
  const now = performance.now();
  const timeSinceKeystroke = now - lastKeystrokeTime;
  const isTyping = lastKeystrokeTime > 0 && timeSinceKeystroke < TYPING_TIMEOUT_MS;
  const typingGazeTarget = isTyping ? TYPING_GAZE_DOWN : 0;
  typingGazeSpring = springDamped(typingGazeSpring, typingGazeTarget, TYPING_GAZE_HL, dt);

  // --- Boredom — long silence triggers wandering gaze + more fidgets ---
  const silenceDuration = lastKeystrokeTime > 0 ? timeSinceKeystroke : 0;
  const isBored = silenceDuration > BOREDOM_ONSET_MS && mode === 'idle';
  const isDeeplyBored = silenceDuration > BOREDOM_DEEP_MS && mode === 'idle';

  if (isBored) {
    // Wandering gaze — slow drifting look-around
    boredGazeTimer += deltaMs;
    const driftInterval = isDeeplyBored ? 3000 : 5000;
    if (boredGazeTimer >= driftInterval) {
      boredGazeTimer = 0;
      const driftAmount = isDeeplyBored ? BOREDOM_GAZE_DRIFT * 1.5 : BOREDOM_GAZE_DRIFT;
      boredGazeTargetX = (Math.random() - 0.5) * 2 * driftAmount;
      boredGazeTargetY = (Math.random() - 0.3) * driftAmount; // bias upward (looking around, not down)
    }
    // Trigger deep breath / sigh periodically
    boredSighTimer += deltaMs;
    const sighInterval = isDeeplyBored ? BOREDOM_SIGH_INTERVAL * 0.7 : BOREDOM_SIGH_INTERVAL;
    if (boredSighTimer >= sighInterval) {
      boredSighTimer = 0;
      // Force a deep breath fidget
      if (!fidgetActive) {
        fidgetActive = true;
        fidgetProgress = 0;
        currentFidget = FIDGET_DEFS.deepBreath;
        fidgetDuration = currentFidget.duration;
        fidgetSign = 1;
      }
    }
    // Increase fidget rate when bored
    if (!fidgetActive && fidgetTimer > 0) {
      fidgetTimer -= deltaMs * (isDeeplyBored ? 3 : 1.5); // fidget 2-4x faster
    }
  } else {
    boredGazeTimer = 0;
    boredGazeTargetX = 0;
    boredGazeTargetY = 0;
    boredSighTimer = 0;
  }
  const boredHL = isDeeplyBored ? 0.6 : 0.8;
  boredGazeSpringX = springDamped(boredGazeSpringX, boredGazeTargetX, boredHL, dt);
  boredGazeSpringY = springDamped(boredGazeSpringY, boredGazeTargetY, boredHL, dt);

  // --- Mode-specific gaze bias ---
  // Thinking: eyes drift up-left (cognitive processing direction)
  // Speaking: gaze centers more on viewer (engagement), slight downward (addressing)
  let gazeBiasX = boredGazeSpringX.pos;
  let gazeBiasY = typingGazeSpring.pos + boredGazeSpringY.pos;
  if (mode === 'thinking') {
    gazeBiasX += -0.25 + fbm(noiseTime * 0.15 + 2100, 2) * 0.15;
    gazeBiasY += 0.2 + fbm(noiseTime * 0.12 + 2200, 2) * 0.1;
  } else if (mode === 'speaking') {
    // Lock gaze on camera — looking the viewer in the eyes
    gazeBiasX = 0;
    gazeBiasY = 0;
  }

  // --- Mouse tracking (spring-based — eyes snap, head follows with momentum) ---
  const breakX = (gazeBreakActive && !isSpeaking) ? gazeBreakOffsetX : 0;
  const breakY = (gazeBreakActive && !isSpeaking) ? gazeBreakOffsetY : 0;

  // Mode-aware mouse influence
  const mouseWeight = mode === 'thinking' ? 0.3 : mode === 'speaking' ? 0.6 : 1.0;
  const mouseTargetX = mouseNormX * MOUSE_EYE_STRENGTH_X * mouseWeight + breakX + gazeBiasX;
  const mouseTargetY = -mouseNormY * MOUSE_EYE_STRENGTH_Y * mouseWeight + breakY + gazeBiasY;
  eyeSpringX = springDamped(eyeSpringX, mouseTargetX, EYE_SPRING_HL, dt);
  eyeSpringY = springDamped(eyeSpringY, mouseTargetY, EYE_SPRING_HL, dt);

  // Head tracks mouse too — spring gives it natural momentum and overshoot
  const headTargetX = mouseNormX * MOUSE_HEAD_STRENGTH_X * mouseWeight + breakX * 0.3 + gazeBiasX * 0.4;
  const headTargetY = -mouseNormY * MOUSE_HEAD_STRENGTH_Y * mouseWeight + breakY * 0.3 + gazeBiasY * 0.3;
  headSpringX = springDamped(headSpringX, headTargetX, HEAD_SPRING_HL, dt);
  headSpringY = springDamped(headSpringY, headTargetY, HEAD_SPRING_HL, dt);

  // Blend: mouse tracking + saccade noise for liveliness
  const saccadeWeight = isSpeaking ? 0.05 : MOUSE_SACCADE_BLEND;
  const eyeX = eyeSpringX.pos + saccadeSpringX.pos * saccadeWeight;
  const eyeY = eyeSpringY.pos + saccadeSpringY.pos * saccadeWeight;

  setExpression('lookLeft', Math.max(0, -eyeX));
  setExpression('lookRight', Math.max(0, eyeX));
  setExpression('lookUp', Math.max(0, eyeY));
  setExpression('lookDown', Math.max(0, -eyeY));

  // Also drive eye bones for convergence and finer control
  // Eye bones give per-eye rotation — we add slight convergence (eyes angle inward)
  if (vrm?.humanoid) {
    const leftEye = vrm.humanoid.getNormalizedBoneNode('leftEye');
    const rightEye = vrm.humanoid.getNormalizedBoneNode('rightEye');
    const eyeRotX = -eyeY * 0.08;  // vertical: negative X = look up
    const eyeRotY = eyeX * 0.08;   // horizontal: positive Y = look right
    // Dynamic convergence — speaking = focused on near listener, thinking = unfocused distance gaze
    const convergence = mode === 'speaking' ? 0.035 : mode === 'thinking' ? 0.005 : 0.02;
    // Physiological eye micro-tremor (nystagmus) — constant tiny rapid oscillation
    // High frequency, very small amplitude — gives eyes a living, wet quality
    const tremorX = Math.sin(noiseTime * 47.3) * 0.001 + Math.sin(noiseTime * 31.7) * 0.0007;
    const tremorY = Math.sin(noiseTime * 53.1) * 0.001 + Math.sin(noiseTime * 37.9) * 0.0007;
    if (leftEye) {
      leftEye.rotation.x = eyeRotX + tremorX;
      leftEye.rotation.y = eyeRotY + convergence + tremorY;
    }
    if (rightEye) {
      rightEye.rotation.x = eyeRotX + tremorX * 0.95; // slightly different per eye
      rightEye.rotation.y = eyeRotY - convergence + tremorY * 1.05;
    }
  }

  // --- Facial micro-expressions (subtle, noise-driven) ---
  const browNoise = fbm(noiseTime * 0.1 + 1200, 2);
  if (browNoise > 0.3) {
    setExpression('surprised', (browNoise - 0.3) * 0.15);
  } else {
    setExpression('surprised', 0);
  }

  const mouthNoise = fbm(noiseTime * 0.06 + 1300, 2);
  if (!isSpeaking && mouthNoise > 0.2) {
    setExpression('happy', (mouthNoise - 0.2) * 0.1);
  } else if (!isSpeaking) {
    setExpression('happy', 0);
  }

  // --- Speaking micro-expressions (eyebrow emphasis, squints on stress) ---
  if (isSpeaking) {
    // Occasional eyebrow raise on emphasis — driven by noise at speaking rate
    const speakBrowNoise = fbm(noiseTime * 0.5 + 1400, 2);
    if (speakBrowNoise > 0.25) {
      setExpression('surprised', (speakBrowNoise - 0.25) * 0.2);
    }
    // Subtle squint on concentration/emphasis
    const speakSquintNoise = fbm(noiseTime * 0.3 + 1500, 2);
    if (speakSquintNoise > 0.4) {
      setExpression('squint', (speakSquintNoise - 0.4) * 0.15);
    }
    // Slight smile while speaking — engaged/friendly
    setExpression('happy', 0.05 + fbm(noiseTime * 0.2 + 1600, 2) * 0.05);
  }

  // --- Swallow animation (periodic involuntary throat movement in idle) ---
  // Humans swallow every 30-60 seconds — subtle jaw + head dip
  if (!isSpeaking && vrm?.humanoid) {
    const swallowPeriod = 35 + fbm(noiseTime * 0.01 + 4000, 1) * 25; // 35-60s
    const swallowPhase = (noiseTime % swallowPeriod) / swallowPeriod;
    // Swallow window: brief 0.4s event near phase 0
    if (swallowPhase < 0.012) { // ~0.4s out of 35s
      const st = swallowPhase / 0.012; // 0→1 within swallow
      const swallowCurve = Math.sin(st * Math.PI); // bell curve
      const jaw = vrm.humanoid.getNormalizedBoneNode('jaw');
      if (jaw) {
        jaw.rotation.x += swallowCurve * 0.02; // tiny jaw close
      }
      // Micro head dip with swallow
      const head = vrm.humanoid.getNormalizedBoneNode('head');
      if (head) {
        head.rotation.x += swallowCurve * -0.008;
      }
    }
  }

  // --- Head + neck movement (noise drift + spring mouse tracking + tilt holds + breathing) ---
  // Dynamic neck/head split: small turns are mostly head, large turns recruit neck
  // This mimics real cervical spine mechanics
  if (vrm?.humanoid) {
    const totalY = fbm(noiseTime * 0.08, 3) * 0.06 * headAmplitude + headSpringX.pos;
    const totalX = fbm(noiseTime * 0.06 + 100, 3) * 0.04 * headAmplitude
      + headSpringY.pos
      + breatheCycle * BREATHE_HEAD_AMOUNT * fidgetBreathScale;
    const totalZ = fbm(noiseTime * 0.05 + 200, 2) * 0.025 * headAmplitude
      + tiltSpring.pos
      + ASYM_HEAD_TILT;

    // Dynamic split: neck share increases with total rotation magnitude
    // Small movements (< 0.1 rad): 30% neck / 70% head
    // Large movements (> 0.3 rad): 50% neck / 50% head
    const rotMag = Math.sqrt(totalY * totalY + totalX * totalX);
    const neckShare = 0.30 + Math.min(rotMag / 0.3, 1.0) * 0.20; // 0.30 → 0.50
    const headShare = 1.0 - neckShare;

    const neck = vrm.humanoid.getNormalizedBoneNode('neck');
    if (neck) {
      neck.rotation.y = totalY * neckShare;
      neck.rotation.x = totalX * neckShare + breatheCycle * -BREATHE_NECK_AMOUNT * fidgetBreathScale;
      neck.rotation.z = totalZ * neckShare + cw * CONTRA_NECK_Z;
    }

    const head = vrm.humanoid.getNormalizedBoneNode('head');
    if (head) {
      head.rotation.y = totalY * headShare;
      head.rotation.x = totalX * headShare;
      head.rotation.z = totalZ * headShare;
    }
  }
}

export function resetIdle(): void {
  blinkProgress = -1;
  doubleBlink = false;
  doubleBlinkGap = -1;
  blinkTimer = randomRange(BLINK_MIN_INTERVAL, BLINK_MAX_INTERVAL);
  saccadeSpringX = createSpring();
  saccadeSpringY = createSpring();
  eyeSpringX = createSpring();
  eyeSpringY = createSpring();
  headSpringX = createSpring();
  headSpringY = createSpring();
  tiltSpring = createSpring();
  tiltHoldActive = false;
  tiltHoldTarget = 0;
  tiltHoldTimer = randomRange(TILT_HOLD_MIN_INTERVAL, TILT_HOLD_MAX_INTERVAL);
  gazeBreakActive = false;
  gazeBreakTimer = randomRange(GAZE_BREAK_MIN_INTERVAL, GAZE_BREAK_MAX_INTERVAL);
  typingGazeSpring = createSpring();
  lastKeystrokeTime = 0;
  boredGazeSpringX = createSpring();
  boredGazeSpringY = createSpring();
  boredGazeTimer = 0;
  boredSighTimer = 0;
  boredGazeTargetX = 0;
  boredGazeTargetY = 0;
  contraSpring = createSpring();
  contraTimer = randomRange(CONTRA_SHIFT_MIN_INTERVAL, CONTRA_SHIFT_MAX_INTERVAL);
  contraTarget = 0;
  fidgetTimer = randomRange(FIDGET_MIN_INTERVAL, FIDGET_MAX_INTERVAL);
  fidgetActive = false;
  fidgetHipZ = createSpring();
  fidgetSpineX = createSpring();
  fidgetShoulderL = createSpring();
  fidgetShoulderR = createSpring();
  fidgetBreathScale = 1.0;
  currentFidget = null;
}
