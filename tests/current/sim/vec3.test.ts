import { describe, expect, it } from "vitest";
import {
  add,
  clone,
  cross,
  distance,
  dot,
  length,
  normalize,
  scale,
  sub,
  vec3,
} from "../../../src/sim/vec3.js";

describe("sim/vec3", () => {
  it("implements basic vector arithmetic", () => {
    expect(vec3()).toEqual({ x: 0, y: 0, z: 0 });
    expect(add(vec3(1, 2, 3), vec3(4, 5, 6))).toEqual({ x: 5, y: 7, z: 9 });
    expect(sub(vec3(4, 5, 6), vec3(1, 2, 3))).toEqual({ x: 3, y: 3, z: 3 });
    expect(scale(vec3(1, -2, 3), 2)).toEqual({ x: 2, y: -4, z: 6 });
  });

  it("supports dot, cross, length, distance, and normalization", () => {
    expect(dot(vec3(1, 2, 3), vec3(4, 5, 6))).toBe(32);
    expect(cross(vec3(1, 0, 0), vec3(0, 1, 0))).toEqual({ x: 0, y: 0, z: 1 });
    expect(length(vec3(3, 4, 0))).toBe(5);
    expect(distance(vec3(0, 0, 0), vec3(3, 4, 0))).toBe(5);
    expect(normalize(vec3(0, 0, 5))).toEqual({ x: 0, y: 0, z: 1 });
    expect(normalize(vec3(0, 0, 0))).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("clones by value", () => {
    const a = vec3(1, 2, 3);
    const b = clone(a);
    b.x = 10;
    expect(a.x).toBe(1);
  });
});
