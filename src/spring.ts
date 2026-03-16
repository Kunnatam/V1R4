/**
 * Critically damped spring — the gold standard for procedural animation.
 *
 * Unlike linear lerp, a spring has momentum: it overshoots slightly on fast moves,
 * settles naturally, and feels physically grounded. Critically damped = fastest
 * convergence without oscillation (unless you want bounce).
 *
 * Parameterized by half-life: how many seconds until the spring is halfway to target.
 * This is much more intuitive than raw stiffness/damping values.
 *
 * Based on: https://theorangeduck.com/page/spring-roll-call
 */

/**
 * Compute spring constants from half-life.
 * halfLife: seconds until spring reaches 50% of the way to target.
 * Smaller = snappier, larger = floatier.
 *
 * Typical values:
 *   0.05 = very snappy (head nod reaction)
 *   0.1  = responsive (eye tracking)
 *   0.2  = natural (head following mouse)
 *   0.4  = floaty (body sway)
 *   0.8  = very slow (weight shifting)
 */
function dampingFromHalfLife(halfLife: number): number {
  // For critically damped: damping = 4 * ln(2) / halfLife
  return (4.0 * 0.693147) / Math.max(halfLife, 0.001);
}

export interface SpringState {
  pos: number;
  vel: number;
}

/**
 * Update a critically damped spring.
 * Returns new position and velocity.
 *
 * @param current - current spring state {pos, vel}
 * @param target - target position
 * @param halfLife - seconds to reach halfway (see guide above)
 * @param dt - delta time in seconds
 */
export function springDamped(
  current: SpringState,
  target: number,
  halfLife: number,
  dt: number,
): SpringState {
  const d = dampingFromHalfLife(halfLife);
  const d_dt = d * dt;

  // Exact exponential decay solution (stable at any dt)
  const decay = 1.0 + d_dt + 0.48 * d_dt * d_dt + 0.235 * d_dt * d_dt * d_dt;
  const invDecay = 1.0 / decay;

  const err = current.pos - target;
  const errDot = current.vel + err * d;

  const newPos = target + (err + errDot * dt) * invDecay;
  const newVel = (current.vel - errDot * d * dt) * invDecay;

  return { pos: newPos, vel: newVel };
}

/**
 * Underdamped spring — same as critically damped but allows bounce/overshoot.
 * damping_ratio < 1.0 = bouncy, = 1.0 = critically damped, > 1.0 = overdamped
 */
export function springUnderdamped(
  current: SpringState,
  target: number,
  halfLife: number,
  dampingRatio: number,
  dt: number,
): SpringState {
  const d = dampingFromHalfLife(halfLife);
  const stiffness = (d / (2.0 * dampingRatio)) ** 2;
  const damping = d / dampingRatio;

  // Semi-implicit Euler (good enough for animation, stable)
  const force = -stiffness * (current.pos - target) - damping * current.vel;
  const newVel = current.vel + force * dt;
  const newPos = current.pos + newVel * dt;

  return { pos: newPos, vel: newVel };
}

/** Create a fresh spring state at a given position. */
export function createSpring(pos: number = 0): SpringState {
  return { pos, vel: 0 };
}

/**
 * Vec3 spring — three independent springs for 3D tracking.
 */
export interface SpringVec3 {
  x: SpringState;
  y: SpringState;
  z: SpringState;
}

export function createSpringVec3(x = 0, y = 0, z = 0): SpringVec3 {
  return {
    x: createSpring(x),
    y: createSpring(y),
    z: createSpring(z),
  };
}

