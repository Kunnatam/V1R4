import { getVRM } from './avatar';
import { createSpring, springDamped, SpringState } from './spring';
import { fbm } from './noise';
import type { Mode } from './state';

/**
 * Procedural hand animation system.
 *
 * Handles idle finger fidgeting, mode-based hand poses, and natural
 * micro-movements that make hands feel alive rather than stiff.
 */

// VRM finger bone names — all available finger bones
type Side = 'left' | 'right';
type Finger = 'Thumb' | 'Index' | 'Middle' | 'Ring' | 'Little';
type Segment = 'Proximal' | 'Intermediate' | 'Distal';

// Hand pose — rotation values for each finger segment (Z axis = curl)
interface FingerPose {
  proximal: number;
  intermediate: number;
  distal: number;
}

interface HandPose {
  thumb: FingerPose;
  index: FingerPose;
  middle: FingerPose;
  ring: FingerPose;
  little: FingerPose;
  wristX: number;  // wrist bend (up/down)
  wristZ: number;  // wrist twist
}

// Preset hand poses
const HAND_POSES: Record<string, HandPose> = {
  // Natural relaxed — fingers slightly curled, cascade from index to little
  relaxed: {
    thumb: { proximal: 0.15, intermediate: 0.1, distal: 0.1 },
    index: { proximal: 0.25, intermediate: 0.3, distal: 0.2 },
    middle: { proximal: 0.3, intermediate: 0.35, distal: 0.25 },
    ring: { proximal: 0.35, intermediate: 0.4, distal: 0.3 },
    little: { proximal: 0.4, intermediate: 0.45, distal: 0.35 },
    wristX: 0,
    wristZ: 0,
  },
  // Open hand — fingers spread
  open: {
    thumb: { proximal: -0.1, intermediate: 0, distal: 0 },
    index: { proximal: 0, intermediate: 0, distal: 0 },
    middle: { proximal: 0, intermediate: 0, distal: 0 },
    ring: { proximal: 0, intermediate: 0, distal: 0 },
    little: { proximal: 0, intermediate: 0, distal: 0 },
    wristX: 0,
    wristZ: 0,
  },
  // Gentle fist — loosely closed
  fist: {
    thumb: { proximal: 0.4, intermediate: 0.5, distal: 0.3 },
    index: { proximal: 0.7, intermediate: 0.8, distal: 0.6 },
    middle: { proximal: 0.75, intermediate: 0.85, distal: 0.65 },
    ring: { proximal: 0.8, intermediate: 0.9, distal: 0.7 },
    little: { proximal: 0.85, intermediate: 0.9, distal: 0.7 },
    wristX: 0.05,
    wristZ: 0,
  },
  // Speaking — slightly more open, gestural hands
  speaking: {
    thumb: { proximal: 0.1, intermediate: 0.08, distal: 0.05 },
    index: { proximal: 0.15, intermediate: 0.2, distal: 0.1 },
    middle: { proximal: 0.2, intermediate: 0.25, distal: 0.15 },
    ring: { proximal: 0.25, intermediate: 0.3, distal: 0.2 },
    little: { proximal: 0.3, intermediate: 0.35, distal: 0.25 },
    wristX: 0.05,
    wristZ: 0,
  },
  // Thinking — index and thumb near chin, others relaxed
  thinking: {
    thumb: { proximal: 0.2, intermediate: 0.15, distal: 0.1 },
    index: { proximal: 0.15, intermediate: 0.1, distal: 0.05 },
    middle: { proximal: 0.5, intermediate: 0.6, distal: 0.4 },
    ring: { proximal: 0.55, intermediate: 0.65, distal: 0.45 },
    little: { proximal: 0.6, intermediate: 0.7, distal: 0.5 },
    wristX: 0.1,
    wristZ: 0,
  },
};

// Wrist compensation — wrist extends (bends back) as fingers curl
// Flexor tendons cross the wrist; curling fingers tightens them, pulling wrist into extension
const WRIST_COMP_STRENGTH = 0.08;  // max wrist extension at full fist (~4.5°)
const WRIST_COMP_HL = 0.18;       // spring half-life for smooth follow

// Finger spread (abduction) — disabled, breaks on current VRM model
// TODO: investigate correct axis/sign per model
// const FINGER_SPREAD: Record<string, number> = {
//   Index:   0.06, Middle:  0.02, Ring:   -0.03, Little: -0.06,
// };

// Spring half-life for finger movement
const FINGER_HL = 0.15;        // natural finger curl speed
const FIDGET_HL = 0.25;        // slower for idle fidgeting

// Fidget timing
const FIDGET_MIN_INTERVAL = 4000;
const FIDGET_MAX_INTERVAL = 12000;

// Spring states — one per finger segment per hand
interface HandSprings {
  thumb: { p: SpringState; i: SpringState; d: SpringState };
  index: { p: SpringState; i: SpringState; d: SpringState };
  middle: { p: SpringState; i: SpringState; d: SpringState };
  ring: { p: SpringState; i: SpringState; d: SpringState };
  little: { p: SpringState; i: SpringState; d: SpringState };
  wristX: SpringState;
  wristZ: SpringState;
}

function createHandSprings(): HandSprings {
  return {
    thumb: { p: createSpring(), i: createSpring(), d: createSpring() },
    index: { p: createSpring(), i: createSpring(), d: createSpring() },
    middle: { p: createSpring(), i: createSpring(), d: createSpring() },
    ring: { p: createSpring(), i: createSpring(), d: createSpring() },
    little: { p: createSpring(), i: createSpring(), d: createSpring() },
    wristX: createSpring(),
    wristZ: createSpring(),
  };
}

// State
let leftSprings = createHandSprings();
let rightSprings = createHandSprings();
let leftTarget: HandPose = { ...HAND_POSES.relaxed };
let rightTarget: HandPose = { ...HAND_POSES.relaxed };
let leftWristCompSpring: SpringState = createSpring();
let rightWristCompSpring: SpringState = createSpring();

let elapsed = 0;
let fidgetTimerL = randomRange(FIDGET_MIN_INTERVAL, FIDGET_MAX_INTERVAL);
let fidgetTimerR = randomRange(FIDGET_MIN_INTERVAL, FIDGET_MAX_INTERVAL);

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Get the appropriate hand pose based on mode */
function getPoseForMode(mode: Mode, side: Side): HandPose {
  switch (mode) {
    case 'thinking':
      return side === 'right' ? HAND_POSES.thinking : HAND_POSES.relaxed;
    case 'speaking':
      return HAND_POSES.speaking;
    default:
      return HAND_POSES.relaxed;
  }
}

/** Add subtle noise-based fidgeting to a hand pose */
function addFidget(base: HandPose, noiseTime: number, seed: number): HandPose {
  const fidgetAmount = 0.08; // max fidget rotation
  return {
    ...base,
    index: {
      proximal: base.index.proximal + fbm(noiseTime * 0.15 + seed, 2) * fidgetAmount,
      intermediate: base.index.intermediate + fbm(noiseTime * 0.12 + seed + 10, 2) * fidgetAmount,
      distal: base.index.distal + fbm(noiseTime * 0.1 + seed + 20, 2) * fidgetAmount * 0.5,
    },
    middle: {
      proximal: base.middle.proximal + fbm(noiseTime * 0.13 + seed + 30, 2) * fidgetAmount * 0.7,
      intermediate: base.middle.intermediate + fbm(noiseTime * 0.11 + seed + 40, 2) * fidgetAmount * 0.7,
      distal: base.middle.distal + fbm(noiseTime * 0.09 + seed + 50, 2) * fidgetAmount * 0.4,
    },
    thumb: {
      proximal: base.thumb.proximal + fbm(noiseTime * 0.08 + seed + 60, 2) * fidgetAmount * 0.5,
      intermediate: base.thumb.intermediate + fbm(noiseTime * 0.07 + seed + 70, 2) * fidgetAmount * 0.3,
      distal: base.thumb.distal,
    },
    ring: base.ring,
    little: base.little,
    wristX: base.wristX + fbm(noiseTime * 0.06 + seed + 80, 2) * 0.03,
    wristZ: base.wristZ + fbm(noiseTime * 0.05 + seed + 90, 2) * 0.02,
  };
}

function applyHandSprings(
  springs: HandSprings,
  target: HandPose,
  hl: number,
  dt: number,
): HandSprings {
  return {
    thumb: {
      p: springDamped(springs.thumb.p, target.thumb.proximal, hl, dt),
      i: springDamped(springs.thumb.i, target.thumb.intermediate, hl, dt),
      d: springDamped(springs.thumb.d, target.thumb.distal, hl, dt),
    },
    index: {
      p: springDamped(springs.index.p, target.index.proximal, hl, dt),
      i: springDamped(springs.index.i, target.index.intermediate, hl, dt),
      d: springDamped(springs.index.d, target.index.distal, hl, dt),
    },
    middle: {
      p: springDamped(springs.middle.p, target.middle.proximal, hl, dt),
      i: springDamped(springs.middle.i, target.middle.intermediate, hl, dt),
      d: springDamped(springs.middle.d, target.middle.distal, hl, dt),
    },
    ring: {
      p: springDamped(springs.ring.p, target.ring.proximal, hl, dt),
      i: springDamped(springs.ring.i, target.ring.intermediate, hl, dt),
      d: springDamped(springs.ring.d, target.ring.distal, hl, dt),
    },
    little: {
      p: springDamped(springs.little.p, target.little.proximal, hl, dt),
      i: springDamped(springs.little.i, target.little.intermediate, hl, dt),
      d: springDamped(springs.little.d, target.little.distal, hl, dt),
    },
    wristX: springDamped(springs.wristX, target.wristX, hl, dt),
    wristZ: springDamped(springs.wristZ, target.wristZ, hl, dt),
  };
}

function setBone(side: Side, finger: Finger, segment: Segment, value: number): void {
  const vrm = getVRM();
  if (!vrm?.humanoid) return;
  // Thumb's first segment is "Metacarpal" not "Proximal" in VRM
  const segName = finger === 'Thumb' && segment === 'Proximal' ? 'Metacarpal' : segment;
  const boneName = `${side}${finger}${segName}` as any;
  const bone = vrm.humanoid.getNormalizedBoneNode(boneName);
  if (bone) {
    // Finger curl is Z rotation (positive = curl inward)
    bone.rotation.z = side === 'left' ? value : -value;
  }
}

/** Compute average finger curl (excluding thumb — different biomechanics) */
function averageFingerCurl(springs: HandSprings): number {
  const fingers = [springs.index, springs.middle, springs.ring, springs.little];
  let sum = 0;
  for (const f of fingers) {
    // Weight proximal most (biggest visual curl), intermediate second, distal least
    sum += f.p.pos * 0.5 + f.i.pos * 0.35 + f.d.pos * 0.15;
  }
  return sum / fingers.length;
}

function applyHandBones(side: Side, springs: HandSprings, wristCompSpring: SpringState, dt: number): { wristComp: SpringState } {
  const vrm = getVRM();
  if (!vrm?.humanoid) return { wristComp: wristCompSpring };

  // Apply finger curls
  const fingers: [Finger, { p: SpringState; i: SpringState; d: SpringState }][] = [
    ['Thumb', springs.thumb],
    ['Index', springs.index],
    ['Middle', springs.middle],
    ['Ring', springs.ring],
    ['Little', springs.little],
  ];

  for (const [finger, segs] of fingers) {
    setBone(side, finger, 'Proximal', segs.p.pos);
    setBone(side, finger, 'Intermediate', segs.i.pos);
    setBone(side, finger, 'Distal', segs.d.pos);

    // Finger spread disabled — Y-axis rotation breaks some VRM models
    // TODO: investigate correct axis/sign per model
    // const spreadAmount = FINGER_SPREAD[finger] ?? 0;
    // if (spreadAmount !== 0) {
    //   const curlFactor = 1.0 - Math.min(segs.p.pos / 0.6, 1.0);
    //   const boneName = `${side}${finger}Proximal` as any;
    //   const bone = vrm.humanoid.getNormalizedBoneNode(boneName);
    //   if (bone) {
    //     bone.rotation.y = (side === 'left' ? spreadAmount : -spreadAmount) * curlFactor;
    //   }
    // }
  }

  // Wrist compensation: extend wrist proportional to finger curl
  const curl = averageFingerCurl(springs);
  const compTarget = -curl * WRIST_COMP_STRENGTH; // negative = extension (bend back)
  const newWristComp = springDamped(wristCompSpring, compTarget, WRIST_COMP_HL, dt);

  // Apply wrist
  const handBone = vrm.humanoid.getNormalizedBoneNode(side === 'left' ? 'leftHand' : 'rightHand');
  if (handBone) {
    handBone.rotation.x = springs.wristX.pos + newWristComp.pos;
    handBone.rotation.z += springs.wristZ.pos;
  }

  return { wristComp: newWristComp };
}

export function updateHands(deltaMs: number, mode: Mode, amplitude: number = 0): void {
  const vrm = getVRM();
  if (!vrm?.humanoid) return;
  const dt = deltaMs / 1000;
  elapsed += dt;

  // Get base poses for current mode
  const leftBase = getPoseForMode(mode, 'left');
  const rightBase = getPoseForMode(mode, 'right');

  // Add fidget noise
  leftTarget = addFidget(leftBase, elapsed, 2000);
  rightTarget = addFidget(rightBase, elapsed, 3000);

  // Speaking gesticulation — amplitude-reactive hand emphasis
  // Loud: fingers open wider, hands more expressive. Quiet: settle toward speaking pose.
  if (mode === 'speaking') {
    const energy = Math.min(amplitude * 2.5, 1.0);
    const gestureAmount = 0.08 + energy * 0.12; // 0.08 baseline, up to 0.20 on loud
    // Asymmetric timing per hand — looks more natural
    const gestL = fbm(elapsed * 0.4 + 4000, 2) * gestureAmount;
    const gestR = fbm(elapsed * 0.35 + 5000, 2) * gestureAmount;
    // All fingers track together during gestures (like an open-palm gesture)
    for (const finger of ['index', 'middle', 'ring', 'little'] as const) {
      leftTarget[finger].proximal += gestL;
      leftTarget[finger].intermediate += gestL * 0.8;
      rightTarget[finger].proximal += gestR;
      rightTarget[finger].intermediate += gestR * 0.8;
    }
    // Amplitude opens fingers on emphasis — negative curl = more open
    const ampOpen = -energy * 0.06;
    for (const finger of ['index', 'middle', 'ring', 'little'] as const) {
      leftTarget[finger].proximal += ampOpen;
      rightTarget[finger].proximal += ampOpen;
    }
    // Wrist follows gesture + amplitude energy
    leftTarget.wristX += gestL * 0.3 + energy * 0.03;
    rightTarget.wristX += gestR * 0.3 + energy * 0.03;
  }

  // Occasional larger fidget — a finger twitch or adjustment
  fidgetTimerL -= deltaMs;
  if (fidgetTimerL <= 0) {
    fidgetTimerL = randomRange(FIDGET_MIN_INTERVAL, FIDGET_MAX_INTERVAL);
    // Random extra curl on a finger
    const extra = 0.15 + Math.random() * 0.2;
    const pick = Math.floor(Math.random() * 4);
    if (pick === 0) leftTarget.index.proximal += extra;
    else if (pick === 1) leftTarget.middle.proximal += extra;
    else if (pick === 2) leftTarget.ring.proximal += extra;
    else leftTarget.little.proximal += extra;
  }

  fidgetTimerR -= deltaMs;
  if (fidgetTimerR <= 0) {
    fidgetTimerR = randomRange(FIDGET_MIN_INTERVAL, FIDGET_MAX_INTERVAL);
    const extra = 0.15 + Math.random() * 0.2;
    const pick = Math.floor(Math.random() * 4);
    if (pick === 0) rightTarget.index.proximal += extra;
    else if (pick === 1) rightTarget.middle.proximal += extra;
    else if (pick === 2) rightTarget.ring.proximal += extra;
    else rightTarget.little.proximal += extra;
  }

  // Update springs
  const hl = mode === 'thinking' ? FINGER_HL : FIDGET_HL;
  leftSprings = applyHandSprings(leftSprings, leftTarget, hl, dt);
  rightSprings = applyHandSprings(rightSprings, rightTarget, hl, dt);

  // Apply to bones (with wrist compensation)
  const leftResult = applyHandBones('left', leftSprings, leftWristCompSpring, dt);
  leftWristCompSpring = leftResult.wristComp;
  const rightResult = applyHandBones('right', rightSprings, rightWristCompSpring, dt);
  rightWristCompSpring = rightResult.wristComp;
}

export function resetHands(): void {
  leftSprings = createHandSprings();
  rightSprings = createHandSprings();
  leftTarget = { ...HAND_POSES.relaxed };
  rightTarget = { ...HAND_POSES.relaxed };
  leftWristCompSpring = createSpring();
  rightWristCompSpring = createSpring();
  fidgetTimerL = randomRange(FIDGET_MIN_INTERVAL, FIDGET_MAX_INTERVAL);
  fidgetTimerR = randomRange(FIDGET_MIN_INTERVAL, FIDGET_MAX_INTERVAL);
  elapsed = 0;
}
