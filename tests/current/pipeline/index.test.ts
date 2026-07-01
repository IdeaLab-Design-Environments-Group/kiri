import { describe, expect, it } from "vitest";
import * as pipeline from "../../../src/pipeline/index.js";

describe("pipeline/index barrel", () => {
  it("re-exports the public pipeline stages", () => {
    expect(typeof pipeline.buildTopology).toBe("function");
    expect(typeof pipeline.parseMesh).toBe("function");
    expect(typeof pipeline.angleDefects).toBe("function");
    expect(typeof pipeline.planCuts).toBe("function");
    expect(typeof pipeline.seamedUnfold).toBe("function");
    expect(typeof pipeline.placeSheet).toBe("function");
    expect(typeof pipeline.lipSubtype).toBe("function");
    expect(typeof pipeline.emitFkld).toBe("function");
    expect(typeof pipeline.verifyFold).toBe("function");
    expect(typeof pipeline.kirigamize).toBe("function");
  });
});
