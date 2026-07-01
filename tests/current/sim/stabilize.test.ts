/**
 * Unit tests for the shared stabilization passes (`src/sim/stabilize.ts`) — the physics moved out
 * of the view so the headless solver and the canvas share one implementation. These pin the math.
 */
import { describe, it, expect } from "vitest";
import {
  totalKineticEnergy,
  kineticDamp,
  dampVelocity,
  removeRigidBodyMotion,
  guardFinite,
} from "../../../src/sim/stabilize.js";

describe("totalKineticEnergy", () => {
  it("is Σ|v|²", () => {
    expect(totalKineticEnergy({ velocity: new Float32Array([3, 4, 0]) })).toBeCloseTo(25, 6);
    expect(totalKineticEnergy({ velocity: new Float32Array([0, 0, 0]) })).toBe(0);
  });
});

describe("dampVelocity", () => {
  it("scales every component", () => {
    const v = new Float32Array([2, 4, -6]);
    dampVelocity({ velocity: v }, 0.5);
    expect([...v]).toEqual([1, 2, -3]);
  });
});

describe("kineticDamp (Otter quench)", () => {
  it("zeros velocity and returns 0 when KE has stopped rising (ke < prevKE)", () => {
    const v = new Float32Array([1, 0, 0, 0, 2, 0]); // ke = 5
    const next = kineticDamp({ velocity: v }, 10); // 5 < 10 → quench
    expect(next).toBe(0);
    expect([...v]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("leaves velocity untouched and returns ke while energy is still rising", () => {
    const v = new Float32Array([1, 0, 0, 0, 2, 0]); // ke = 5
    const next = kineticDamp({ velocity: v }, 3); // 5 > 3 → keep
    expect(next).toBeCloseTo(5, 6);
    expect([...v]).toEqual([1, 0, 0, 0, 2, 0]);
  });
});

describe("removeRigidBodyMotion", () => {
  const fixed2 = new Uint8Array([0, 0]);

  it("removes a pure rigid translation", () => {
    const position = new Float32Array([-1, 0, 0, 1, 0, 0]);
    const velocity = new Float32Array([1, 0, 0, 1, 0, 0]); // both drifting +x
    removeRigidBodyMotion({ velocity, position, numNodes: 2, fixed: fixed2 });
    for (const c of velocity) expect(c).toBeCloseTo(0, 6);
  });

  it("removes a pure rigid rotation about the centroid", () => {
    const position = new Float32Array([1, 0, 0, -1, 0, 0]);
    const velocity = new Float32Array([0, 1, 0, 0, -1, 0]); // spin about z
    removeRigidBodyMotion({ velocity, position, numNodes: 2, fixed: fixed2 });
    for (const c of velocity) expect(c).toBeCloseTo(0, 6);
  });

  it("preserves an internal deformation (zero net linear + angular momentum)", () => {
    const position = new Float32Array([-1, 0, 0, 1, 0, 0]);
    const velocity = new Float32Array([-1, 0, 0, 1, 0, 0]); // stretching apart
    removeRigidBodyMotion({ velocity, position, numNodes: 2, fixed: fixed2 });
    expect([...velocity]).toEqual([-1, 0, 0, 1, 0, 0]);
  });

  it("holds fixed nodes at zero velocity", () => {
    const position = new Float32Array([-1, 0, 0, 1, 0, 0]);
    const velocity = new Float32Array([5, 5, 5, -3, 0, 0]);
    removeRigidBodyMotion({ velocity, position, numNodes: 2, fixed: new Uint8Array([1, 0]) });
    expect([velocity[0], velocity[1], velocity[2]]).toEqual([0, 0, 0]);
  });
});

describe("guardFinite (divergence guard)", () => {
  it("returns true and leaves a clean model untouched", () => {
    const velocity = new Float32Array([1, 0, 0]);
    const position = new Float32Array([0, 0, 0]);
    expect(guardFinite({ velocity, position, numNodes: 1 })).toBe(true);
    expect([...velocity]).toEqual([1, 0, 0]);
  });

  it("catches a NaN velocity and zeros that node, returning false", () => {
    const velocity = new Float32Array([NaN, 0, 0, 1, 1, 1]);
    const position = new Float32Array([0, 0, 0, 0, 0, 0]);
    expect(guardFinite({ velocity, position, numNodes: 2 })).toBe(false);
    expect([velocity[0], velocity[1], velocity[2]]).toEqual([0, 0, 0]);
    expect([velocity[3], velocity[4], velocity[5]]).toEqual([1, 1, 1]); // clean node untouched
  });

  it("catches a non-finite position", () => {
    const velocity = new Float32Array([1, 0, 0]);
    const position = new Float32Array([Infinity, 0, 0]);
    expect(guardFinite({ velocity, position, numNodes: 1 })).toBe(false);
  });

  it("catches a runaway speed above maxSpeed", () => {
    const velocity = new Float32Array([1000, 0, 0]);
    const position = new Float32Array([0, 0, 0]);
    expect(guardFinite({ velocity, position, numNodes: 1 }, 10)).toBe(false);
    expect([...velocity]).toEqual([0, 0, 0]);
  });
});
