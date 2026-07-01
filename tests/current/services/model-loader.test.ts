import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSample, parseLoaded, loadedStatus, readModelFile } from "../../../src/services/model-loader.js";
import { AppError } from "../../../src/core/errors.js";

const FOLD = JSON.stringify({
  vertices_coords: [[0, 0], [1, 0], [1, 1]],
  faces_vertices: [[0, 1, 2]],
  edges_vertices: [[0, 1], [1, 2], [2, 0]],
});

describe("services/model-loader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses .fold/.fkld/.json text into a fold model", () => {
    for (const name of ["a.fold", "a.fkld", "a.json"]) {
      const m = parseLoaded(FOLD, name);
      expect(m.kind).toBe("fold");
      expect(m.name).toBe(name);
    }
  });

  it("routes .obj/.stl text into a mesh model", () => {
    const m = parseLoaded("v 0 0 0", "shape.obj");
    expect(m).toEqual({ kind: "mesh", name: "shape.obj", ext: "obj", text: "v 0 0 0" });
  });

  it("throws AppError(parse) with the exact UI message on bad JSON", () => {
    let err: unknown;
    try {
      parseLoaded("{broken", "broken.fold");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).domain).toBe("parse");
    expect((err as AppError).message).toContain("Parse error in broken.fold");
  });

  it("throws AppError(io) with the exact UI message on unsupported extensions", () => {
    expect(() => parseLoaded("hello", "note.txt")).toThrowError(/Unsupported file type: \.txt/);
    try {
      parseLoaded("hello", "note.txt");
    } catch (e) {
      expect((e as AppError).domain).toBe("io");
    }
  });

  it("readModelFile keeps the synchronous FileReader callback timing", () => {
    class FileReaderMock {
      result = FOLD;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsText(): void {
        this.onload?.();
      }
    }
    const original = globalThis.FileReader;
    globalThis.FileReader = FileReaderMock as unknown as typeof FileReader;
    try {
      let loaded: unknown = null;
      readModelFile({ name: "ok.fold" } as File, (m) => (loaded = m), () => {});
      // must have fired synchronously — same tick as readAsText
      expect(loaded).not.toBeNull();
    } finally {
      globalThis.FileReader = original;
    }
  });

  it("readModelFile forwards parse failures as AppError(parse)", () => {
    class FileReaderMock {
      result = "{broken";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsText(): void {
        this.onload?.();
      }
    }
    const original = globalThis.FileReader;
    globalThis.FileReader = FileReaderMock as unknown as typeof FileReader;
    try {
      const onLoaded = vi.fn();
      const onError = vi.fn();
      readModelFile({ name: "broken.fold" } as File, onLoaded, onError);

      expect(onLoaded).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]![0]).toBeInstanceOf(AppError);
      expect(onError.mock.calls[0]![0].domain).toBe("parse");
    } finally {
      globalThis.FileReader = original;
    }
  });

  it("readModelFile reports FileReader transport failures as AppError(io)", () => {
    class FileReaderMock {
      result = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsText(): void {
        this.onerror?.();
      }
    }
    const original = globalThis.FileReader;
    globalThis.FileReader = FileReaderMock as unknown as typeof FileReader;
    try {
      const onError = vi.fn();
      readModelFile({ name: "bad.fold" } as File, vi.fn(), onError);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]![0]).toBeInstanceOf(AppError);
      expect(onError.mock.calls[0]![0].domain).toBe("io");
      expect(onError.mock.calls[0]![0].message).toContain("Could not read bad.fold.");
    } finally {
      globalThis.FileReader = original;
    }
  });

  it("fetchSample returns the fetched fold payload on HTTP success", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => FOLD,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSample("/sample.fold", "sample.fold")).resolves.toEqual({
      kind: "fold",
      name: "sample.fold",
      object: JSON.parse(FOLD),
    });
    expect(fetchMock).toHaveBeenCalledWith("/sample.fold");
  });

  it("fetchSample throws AppError(io) on HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));

    await expect(fetchSample("/missing.fold", "missing.fold")).rejects.toMatchObject({
      domain: "io",
      message: "HTTP 404",
    });
  });

  it("loadedStatus reproduces the pre-extraction status strings", () => {
    const fold = parseLoaded(FOLD, "ok.fold");
    expect(loadedStatus(fold).msg).toContain('Loaded FOLD model "ok.fold"');
    expect(loadedStatus(fold).kind).toBe("ok");
    const mesh = parseLoaded("v 0 0 0", "shape.stl");
    expect(loadedStatus(mesh)).toEqual({
      msg: 'Loaded STL mesh "shape.stl". Press Kirigamize ▶ to convert.',
      kind: "",
    });
  });
});
