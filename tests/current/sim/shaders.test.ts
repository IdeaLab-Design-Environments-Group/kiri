import { describe, expect, it } from "vitest";
import { POSITION_SHADER, VELOCITY_SHADER } from "../../../src/sim/gpu/shaders.js";

describe("sim/gpu/shaders", () => {
  it("exposes both GPU solver shader programs", () => {
    expect(typeof POSITION_SHADER).toBe("string");
    expect(typeof VELOCITY_SHADER).toBe("string");
    expect(POSITION_SHADER.length).toBeGreaterThan(1000);
    expect(VELOCITY_SHADER.length).toBeGreaterThan(1000);
  });

  it("contains the shared gather-force machinery and driven/fixed-node branches", () => {
    for (const shader of [POSITION_SHADER, VELOCITY_SHADER]) {
      expect(shader).toContain("#define MAXDEG 64");
      expect(shader).toContain("vec3 computeForce(float self)");
      expect(shader).toContain("uniform sampler2D uMass");
      expect(shader).toContain("uniform float uFoldPercent");
    }

    expect(POSITION_SHADER).toContain("if (m.z > 0.5)");
    expect(POSITION_SHADER).toContain("mix(rest, goal, uFoldPercent)");
    expect(VELOCITY_SHADER).toContain("if (m.y > 0.5)");
    expect(VELOCITY_SHADER).toContain("v += (f / m.x) * uDt");
  });
});
