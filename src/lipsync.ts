import { setExpression, getVRM } from './avatar';
import { createSpring, springDamped, SpringState } from './spring';

// Viseme config — map amplitude to multiple mouth shapes for richer movement
// Instead of just opening the mouth, we cycle through shapes to simulate phonemes
const SILENCE_THRESHOLD_MS = 120;
const VISEME_CYCLE_SPEED = 0.008;     // how fast to cycle through shapes (per ms)

// Spring half-lives for viseme smoothing
const ATTACK_HL = 0.02;               // fast mouth open
const RELEASE_HL = 0.08;              // gentle mouth close

// Viseme weights — how much each shape contributes at different amplitudes
// Low amplitude = subtle lip movement, high = full mouth shapes
interface VisemeFrame {
  aa: number;
  oh: number;
  ee: number;
  ih: number;
  ou: number;
}

// Cycle pattern — creates natural-looking mouth movement variety
const VISEME_CYCLE: VisemeFrame[] = [
  { aa: 1.0, oh: 0.1, ee: 0.0, ih: 0.0, ou: 0.0 },  // open "ah"
  { aa: 0.3, oh: 0.6, ee: 0.1, ih: 0.0, ou: 0.2 },  // round "oh"
  { aa: 0.1, oh: 0.0, ee: 0.7, ih: 0.3, ou: 0.0 },  // wide "ee"
  { aa: 0.5, oh: 0.3, ee: 0.0, ih: 0.0, ou: 0.1 },  // half open
  { aa: 0.0, oh: 0.1, ee: 0.2, ih: 0.5, ou: 0.0 },  // small "ih"
  { aa: 0.7, oh: 0.0, ee: 0.1, ih: 0.0, ou: 0.0 },  // open again
  { aa: 0.2, oh: 0.0, ee: 0.0, ih: 0.0, ou: 0.6 },  // pucker "ou"
  { aa: 0.4, oh: 0.4, ee: 0.0, ih: 0.1, ou: 0.0 },  // mid blend
];

// State
let aaSpring: SpringState = createSpring();
let ohSpring: SpringState = createSpring();
let eeSpring: SpringState = createSpring();
let ihSpring: SpringState = createSpring();
let ouSpring: SpringState = createSpring();
let jawSpring: SpringState = createSpring();
const JAW_OPEN_AMOUNT = 0.12; // max jaw rotation (radians, ~7°)
let silenceTimer = 0;
let cyclePhase = 0;
let prevAmp = 0;

// Lip press between phrases — brief compression when amplitude drops
const LIP_PRESS_THRESHOLD_MS = 80;    // silence before lip press triggers
const LIP_PRESS_MAX_MS = 600;         // lip press fades after this
const LIP_PRESS_AMOUNT = 0.25;        // 'ou' expression for pursed look
let lipPressActive = false;
let lipPressDuration = 0;

/**
 * Enhanced amplitude-based lip sync.
 * Uses viseme cycling + spring smoothing for natural-looking mouth movement.
 */
export function updateLipSyncAmplitude(amplitude: number, deltaMs: number): void {
  const dt = deltaMs / 1000;
  const amp = Math.min(amplitude * 4.0, 1.0);

  if (amp > 0.05) {
    silenceTimer = 0;
    lipPressActive = false;
    lipPressDuration = 0;

    // Advance cycle phase — faster when louder, with amplitude-driven variation
    const ampDelta = Math.abs(amplitude - prevAmp);
    const speedBoost = 1.0 + ampDelta * 5.0; // speak faster on amplitude changes
    cyclePhase += deltaMs * VISEME_CYCLE_SPEED * speedBoost;

    // Get interpolated viseme from cycle
    const cycleLen = VISEME_CYCLE.length;
    const idx = cyclePhase % cycleLen;
    const i0 = Math.floor(idx) % cycleLen;
    const i1 = (i0 + 1) % cycleLen;
    const frac = idx - Math.floor(idx);

    const v0 = VISEME_CYCLE[i0];
    const v1 = VISEME_CYCLE[i1];

    // Lerp between adjacent viseme frames, scaled by amplitude
    const targetAa = (v0.aa + (v1.aa - v0.aa) * frac) * amp;
    const targetOh = (v0.oh + (v1.oh - v0.oh) * frac) * amp;
    const targetEe = (v0.ee + (v1.ee - v0.ee) * frac) * amp * 0.7;
    const targetIh = (v0.ih + (v1.ih - v0.ih) * frac) * amp * 0.5;
    const targetOu = (v0.ou + (v1.ou - v0.ou) * frac) * amp * 0.6;

    // Springs — fast attack for responsiveness
    aaSpring = springDamped(aaSpring, targetAa, ATTACK_HL, dt);
    ohSpring = springDamped(ohSpring, targetOh, ATTACK_HL, dt);
    eeSpring = springDamped(eeSpring, targetEe, ATTACK_HL, dt);
    ihSpring = springDamped(ihSpring, targetIh, ATTACK_HL, dt);
    ouSpring = springDamped(ouSpring, targetOu, ATTACK_HL, dt);
  } else {
    silenceTimer += deltaMs;
    if (silenceTimer > SILENCE_THRESHOLD_MS) {
      // Gentle release back to closed
      aaSpring = springDamped(aaSpring, 0, RELEASE_HL, dt);
      ohSpring = springDamped(ohSpring, 0, RELEASE_HL, dt);
      eeSpring = springDamped(eeSpring, 0, RELEASE_HL, dt);
      ihSpring = springDamped(ihSpring, 0, RELEASE_HL, dt);

      // Lip press: brief compression between phrases
      if (silenceTimer > LIP_PRESS_THRESHOLD_MS && !lipPressActive && prevAmp > 0.1) {
        lipPressActive = true;
        lipPressDuration = 0;
      }
      if (lipPressActive) {
        lipPressDuration += deltaMs;
        const pressPhase = lipPressDuration < 100 ? lipPressDuration / 100 : // ramp up
          lipPressDuration < 300 ? 1.0 : // hold
          Math.max(0, 1.0 - (lipPressDuration - 300) / 300); // release
        ouSpring = springDamped(ouSpring, LIP_PRESS_AMOUNT * pressPhase, 0.04, dt);
        if (lipPressDuration > LIP_PRESS_MAX_MS) lipPressActive = false;
      } else {
        ouSpring = springDamped(ouSpring, 0, RELEASE_HL, dt);
      }
    }
  }

  prevAmp = amplitude;

  // Apply to VRM expressions (clamped 0-1)
  const aaVal = Math.max(0, Math.min(1, aaSpring.pos));
  const ohVal = Math.max(0, Math.min(1, ohSpring.pos));
  setExpression('aa', aaVal);
  setExpression('oh', ohVal);
  setExpression('ee', Math.max(0, Math.min(1, eeSpring.pos)));
  setExpression('ih', Math.max(0, Math.min(1, ihSpring.pos)));
  setExpression('ou', Math.max(0, Math.min(1, ouSpring.pos)));

  // Jaw bone: tracks the widest mouth opening (aa + oh dominate jaw open)
  const jawTarget = Math.max(aaVal, ohVal * 0.8) * JAW_OPEN_AMOUNT;
  jawSpring = springDamped(jawSpring, jawTarget, amp > 0.05 ? ATTACK_HL : RELEASE_HL, dt);

  const vrm = getVRM();
  if (vrm?.humanoid) {
    const jaw = vrm.humanoid.getNormalizedBoneNode('jaw');
    if (jaw) {
      jaw.rotation.x = jawSpring.pos; // positive X = open jaw
    }
  }
}


export function resetLipSync(): void {
  aaSpring = createSpring();
  ohSpring = createSpring();
  eeSpring = createSpring();
  ihSpring = createSpring();
  ouSpring = createSpring();
  jawSpring = createSpring();
  lipPressActive = false;
  lipPressDuration = 0;
  silenceTimer = 0;
  cyclePhase = 0;
  prevAmp = 0;
  setExpression('aa', 0);
  setExpression('oh', 0);
  setExpression('ee', 0);
  setExpression('ih', 0);
  setExpression('ou', 0);
}
