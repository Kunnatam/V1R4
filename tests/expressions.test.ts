import { describe, it, expect, vi } from 'vitest';

// Mock avatar module to avoid Three.js dependency
vi.mock('../src/avatar', () => ({
  setExpression: vi.fn(),
}));

import { getBlendShapesForMood, lerpBlendShapes, BlendShapeTarget } from '../src/expressions';

describe('getBlendShapesForMood', () => {
  it('returns neutral for null mood', () => {
    expect(getBlendShapesForMood(null)).toEqual({ neutral: 1.0 });
  });

  it('returns angry + squint for error', () => {
    const shapes = getBlendShapesForMood('error');
    expect(shapes.angry).toBeCloseTo(0.5);
    expect(shapes.squint).toBeCloseTo(0.3);
  });

  it('returns happy for success', () => {
    const shapes = getBlendShapesForMood('success');
    expect(shapes.happy).toBeCloseTo(1.0);
  });

  it('returns surprised for warn', () => {
    const shapes = getBlendShapesForMood('warn');
    expect(shapes.surprised).toBeCloseTo(0.4);
  });

  it('returns sad + lookDown for melancholy', () => {
    const shapes = getBlendShapesForMood('melancholy');
    expect(shapes.sad).toBeCloseTo(0.5);
    expect(shapes.lookDown).toBeCloseTo(0.3);
  });

  it('returns neutral for unknown mood', () => {
    expect(getBlendShapesForMood('unknown')).toEqual({ neutral: 1.0 });
  });
});

describe('lerpBlendShapes', () => {
  it('lerps between two shape sets', () => {
    const from: BlendShapeTarget = { happy: 1.0 };
    const to: BlendShapeTarget = { angry: 1.0 };
    const result = lerpBlendShapes(from, to, 0.5);
    expect(result.happy).toBeCloseTo(0.5);
    expect(result.angry).toBeCloseTo(0.5);
  });

  it('returns target at t=1', () => {
    const from: BlendShapeTarget = { happy: 1.0 };
    const to: BlendShapeTarget = { angry: 0.6 };
    const result = lerpBlendShapes(from, to, 1.0);
    expect(result.happy).toBeUndefined();  // 0 values are filtered
    expect(result.angry).toBeCloseTo(0.6);
  });

  it('returns from at t=0', () => {
    const from: BlendShapeTarget = { happy: 0.8 };
    const to: BlendShapeTarget = { angry: 0.6 };
    const result = lerpBlendShapes(from, to, 0.0);
    expect(result.happy).toBeCloseTo(0.8);
    expect(result.angry).toBeUndefined();
  });
});
