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
} from "@kirigami/sim/vec3.js";

describe("vec3", () => {
  it("constructs with defaults and clones independently", () => {
    expect(vec3()).toEqual({ x: 0, y: 0, z: 0 });
    expect(vec3(1, 2, 3)).toEqual({ x: 1, y: 2, z: 3 });
    const a = vec3(1, 2, 3);
    const b = clone(a);
    b.x = 99;
    expect(a.x).toBe(1); // clone is a deep copy
  });

  it("adds, subtracts and scales componentwise", () => {
    expect(add(vec3(1, 2, 3), vec3(4, 5, 6))).toEqual({ x: 5, y: 7, z: 9 });
    expect(sub(vec3(4, 5, 6), vec3(1, 2, 3))).toEqual({ x: 3, y: 3, z: 3 });
    expect(scale(vec3(1, -2, 3), 2)).toEqual({ x: 2, y: -4, z: 6 });
  });

  it("dot product", () => {
    expect(dot(vec3(1, 2, 3), vec3(4, 5, 6))).toBe(32);
    expect(dot(vec3(1, 0, 0), vec3(0, 1, 0))).toBe(0); // orthogonal
  });

  it("cross product follows the right-hand rule (x̂ × ŷ = ẑ)", () => {
    expect(cross(vec3(1, 0, 0), vec3(0, 1, 0))).toEqual({ x: 0, y: 0, z: 1 });
    expect(cross(vec3(0, 1, 0), vec3(0, 0, 1))).toEqual({ x: 1, y: 0, z: 0 });
    // anti-commutative
    expect(cross(vec3(0, 1, 0), vec3(1, 0, 0))).toEqual({ x: 0, y: 0, z: -1 });
  });

  it("length and distance", () => {
    expect(length(vec3(3, 4, 0))).toBe(5);
    expect(length(vec3(2, 3, 6))).toBe(7);
    expect(distance(vec3(0, 0, 0), vec3(3, 4, 0))).toBe(5);
  });

  it("normalize yields a unit vector, and guards the zero vector", () => {
    const n = normalize(vec3(0, 0, 5));
    expect(n).toEqual({ x: 0, y: 0, z: 1 });
    expect(length(normalize(vec3(1, 2, 2)))).toBeCloseTo(1, 12);
    expect(normalize(vec3(0, 0, 0))).toEqual({ x: 0, y: 0, z: 0 }); // no NaN
  });
});
