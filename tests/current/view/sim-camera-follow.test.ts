import { describe, expect, it } from "vitest";
import { followDelta, poseCentre, SimCameraFollow, FOLLOW_DAMPING } from "../../../src/view/sim-camera-follow";

describe("poseCentre", () => {
  it("is the bounding-box centre and skips non-finite nodes", () => {
    const p = new Float32Array([0, 0, 0, 4, 2, 6, NaN, 9, 9]);
    expect(poseCentre(p, 3)).toEqual({ x: 2, y: 1, z: 3 });
  });
});

describe("followDelta", () => {
  it("closes a damped fraction of the gap", () => {
    const d = followDelta({ x: 10, y: 0, z: -5 }, { x: 0, y: 0, z: 0 });
    expect(d.x).toBeCloseTo(10 * FOLLOW_DAMPING);
    expect(d.z).toBeCloseTo(-5 * FOLLOW_DAMPING);
  });
  it("snaps when already almost there and converges", () => {
    expect(followDelta({ x: 1e-6, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }).x).toBeCloseTo(1e-6);
    const t = { x: 0, y: 0, z: 0 }, c = { x: 5, y: 5, z: 5 };
    for (let i = 0; i < 200; i++) { const d = followDelta(c, t); t.x += d.x; t.y += d.y; t.z += d.z; }
    expect(t.x).toBeCloseTo(5, 3);
  });
});

describe("SimCameraFollow", () => {
  const pos = new Float32Array([0, 0, 0, 2, 2, 2]); // centre (1,1,1)
  it("moves target and camera by the same delta (orbit offset preserved)", () => {
    const f = new SimCameraFollow();
    const target = { x: 0, y: 0, z: 0 }, cam = { x: 5, y: -5, z: 3 };
    expect(f.step(pos, 2, target, cam)).toBe(true);
    expect(cam.x - target.x).toBeCloseTo(5);
    expect(cam.y - target.y).toBeCloseTo(-5);
    expect(cam.z - target.z).toBeCloseTo(3);
    expect(target.x).toBeGreaterThan(0);
  });
  it("snap reaches the centre in one step", () => {
    const f = new SimCameraFollow();
    const target = { x: 0, y: 0, z: 0 }, cam = { x: 5, y: 5, z: 5 };
    f.step(pos, 2, target, cam, true);
    expect(target).toEqual({ x: 1, y: 1, z: 1 });
  });
  it("does nothing after stop and resumes after resume", () => {
    const f = new SimCameraFollow();
    const target = { x: 0, y: 0, z: 0 }, cam = { x: 5, y: 5, z: 5 };
    f.stop();
    expect(f.following).toBe(false);
    expect(f.step(pos, 2, target, cam)).toBe(false);
    expect(target).toEqual({ x: 0, y: 0, z: 0 });
    f.resume();
    expect(f.step(pos, 2, target, cam, true)).toBe(true);
    expect(target.x).toBe(1);
  });
});
