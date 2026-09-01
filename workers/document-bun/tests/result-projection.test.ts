import { describe, expect, test } from "bun:test";

import {
  MAX_RESULT_PROJECTION_BYTES,
  serializeResultProjection,
} from "../src/worker";

describe("worker result projection", () => {
  test("serializes a bounded JSON object", () => {
    expect(
      serializeResultProjection({ schema_version: 1, task_id: 7, digest: "abc" }),
    ).toBe('{"schema_version":1,"task_id":7,"digest":"abc"}');
  });

  test("keeps undefined as backward-compatible no-projection completion", () => {
    expect(serializeResultProjection(undefined)).toBeUndefined();
  });

  test("rejects scalar, array, cyclic, and oversized projections", () => {
    expect(() => serializeResultProjection(null)).toThrow();
    expect(() => serializeResultProjection([1, 2, 3])).toThrow();
    expect(() => serializeResultProjection("value")).toThrow();

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => serializeResultProjection(cyclic)).toThrow();

    expect(() =>
      serializeResultProjection({ data: "x".repeat(MAX_RESULT_PROJECTION_BYTES + 1) }),
    ).toThrow();
  });
});
