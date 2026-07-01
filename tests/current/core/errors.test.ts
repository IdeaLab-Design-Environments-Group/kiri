import { describe, expect, it } from "vitest";
import { AppError, statusFromError, toAppError } from "../../../src/core/errors.js";

describe("core/errors", () => {
  it("preserves existing AppErrors", () => {
    const err = new AppError("parse", "bad input", { line: 1 });
    expect(toAppError(err, "io")).toBe(err);
  });

  it("wraps plain errors and prefixes their messages when asked", () => {
    const err = toAppError(new Error("boom"), "sim", "Failed");
    expect(err).toBeInstanceOf(AppError);
    expect(err.domain).toBe("sim");
    expect(err.message).toBe("Failed: boom");
  });

  it("bridges thrown values into bad-status payloads", () => {
    expect(statusFromError("nope", "create")).toEqual({ msg: "nope", kind: "bad" });
  });
});
