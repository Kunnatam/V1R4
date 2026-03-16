import * as THREE from 'three';
import { getVRM } from './avatar';
import { fbm } from './noise';

/**
 * Procedural wind system for VRM spring bones.
 *
 * Since three-vrm v3 doesn't expose an external force API, we simulate wind
 * by dynamically modifying the gravity direction on spring bone joints.
 * This causes hair, clothes, and accessories to sway naturally.
 *
 * The wind uses layered noise for organic, non-repeating gusts.
 */

// Wind config
const BASE_WIND_STRENGTH = 0.3;     // constant gentle breeze
const GUST_STRENGTH = 0.8;          // additional force during gusts
const GUST_FREQUENCY = 0.15;        // how often gusts happen (noise speed)
const WIND_TURBULENCE = 0.4;        // how much the direction varies
const WIND_DIRECTION = new THREE.Vector3(1, 0, 0.3).normalize(); // default: from the right

// Gravity config — base gravity for spring bones
const BASE_GRAVITY_DIR = new THREE.Vector3(0, -1, 0);
const BASE_GRAVITY_POWER = 0.05;    // gentle downward pull

let elapsed = 0;
let enabled = true;

// Store original settings so we can restore them
const origSettings = new Map<number, { gravityPower: number; gravityDir: THREE.Vector3 }>();
let initialized = false;

/** Initialize wind — stores original spring bone settings */
export function initWind(): void {
  const vrm = getVRM();
  if (!vrm?.springBoneManager) return;

  origSettings.clear();
  let i = 0;
  for (const joint of vrm.springBoneManager.joints) {
    origSettings.set(i, {
      gravityPower: joint.settings.gravityPower,
      gravityDir: joint.settings.gravityDir.clone(),
    });
    i++;
  }
  initialized = true;
  if (import.meta.env.DEV) console.log(`[V1R4] Wind system initialized: ${origSettings.size} spring bone joints`);
}

/** Update wind every frame — modifies spring bone gravity to create wind effect */
export function updateWind(deltaMs: number): void {
  if (!enabled || !initialized) return;

  const vrm = getVRM();
  if (!vrm?.springBoneManager) return;

  elapsed += deltaMs / 1000;

  // Layered noise for natural wind variation
  const gustAmount = Math.max(0, fbm(elapsed * GUST_FREQUENCY, 3));
  const windStrength = BASE_WIND_STRENGTH + gustAmount * GUST_STRENGTH;

  // Wind direction varies with turbulence noise
  const turbX = fbm(elapsed * 0.3 + 100, 2) * WIND_TURBULENCE;
  const turbY = fbm(elapsed * 0.2 + 200, 2) * WIND_TURBULENCE * 0.3; // less vertical
  const turbZ = fbm(elapsed * 0.25 + 300, 2) * WIND_TURBULENCE;

  // Combined wind vector
  const windX = WIND_DIRECTION.x + turbX;
  const windY = WIND_DIRECTION.y + turbY;
  const windZ = WIND_DIRECTION.z + turbZ;

  // Combined gravity = base gravity + wind force
  const combinedDir = new THREE.Vector3(
    BASE_GRAVITY_DIR.x + windX * windStrength,
    BASE_GRAVITY_DIR.y + windY * windStrength,
    BASE_GRAVITY_DIR.z + windZ * windStrength,
  ).normalize();

  const combinedPower = BASE_GRAVITY_POWER + windStrength * 0.05;

  // Apply to all spring bone joints
  for (const joint of vrm.springBoneManager.joints) {
    joint.settings.gravityDir.copy(combinedDir);
    joint.settings.gravityPower = combinedPower;
  }
}

/** Enable/disable wind */
export function setWindEnabled(value: boolean): void {
  enabled = value;
  if (!value) restoreOriginalSettings();
}

/** Restore original spring bone settings */
function restoreOriginalSettings(): void {
  const vrm = getVRM();
  if (!vrm?.springBoneManager) return;

  let i = 0;
  for (const joint of vrm.springBoneManager.joints) {
    const orig = origSettings.get(i);
    if (orig) {
      joint.settings.gravityPower = orig.gravityPower;
      joint.settings.gravityDir.copy(orig.gravityDir);
    }
    i++;
  }
}
