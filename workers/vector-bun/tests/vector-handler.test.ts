import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_VECTOR_ELEMENT_ABS,
  MAX_VECTOR_LENGTH,
  VectorPayloadError,
  computeVectorDot,
  parseVectorPayload,
  vectorDotHandler,
  writeVectorResultAtomic,
} from "../src/vector-handler";
import {
  loadVectorWorkerConfig,
  normalizeVectorOrigin,
  vectorWorkerRegistry,
} from "../src/worker";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("vector dot handler", () => {
  test("computes an exact deterministic integer dot product without copying vectors", () => {
    const raw = JSON.stringify({ a: [1, 2, 3], b: [4, 5, 6] });
    const first = computeVectorDot(7, raw);
    const second = computeVectorDot(7, raw);

    expect(first).toEqual(second);
    expect(first).toEqual({ schema_version: 1, task_id: 7, length: 3, dot: 32 });
    expect(JSON.stringify(first)).not.toContain("[1,2,3]");
    expect(JSON.stringify(first)).not.toContain("[4,5,6]");
  });

  test("keeps the documented maximum inside JavaScript safe integer arithmetic", () => {
    const a = Array(MAX_VECTOR_LENGTH).fill(MAX_VECTOR_ELEMENT_ABS);
    const b = Array(MAX_VECTOR_LENGTH).fill(MAX_VECTOR_ELEMENT_ABS);
    const result = computeVectorDot(9, JSON.stringify({ a, b }));

    expect(result.length).toBe(MAX_VECTOR_LENGTH);
    expect(result.dot).toBe(4_096_000_000_000_000);
    expect(Number.isSafeInteger(result.dot)).toBeTrue();
  });

  test("writes one deterministic task artifact atomically and overwrites on retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vector-worker-test-"));
    cleanupPaths.push(dir);
    const result = computeVectorDot(11, JSON.stringify({ a: [2, -3], b: [7, 5] }));

    const firstPath = await writeVectorResultAtomic(dir, result);
    const secondPath = await writeVectorResultAtomic(dir, result);
    expect(firstPath).toBe(secondPath);
    expect(JSON.parse(await readFile(firstPath, "utf8"))).toEqual(result);
  });

  test("fails closed on unknown fields, mismatched lengths, floats, and oversized vectors", () => {
    expect(() => parseVectorPayload('{"a":[1],"b":[1],"command":"run"}')).toThrow(
      VectorPayloadError,
    );
    expect(() => parseVectorPayload('{"a":[1,2],"b":[1]}')).toThrow(VectorPayloadError);
    expect(() => parseVectorPayload('{"a":[1.5],"b":[2]}')).toThrow(VectorPayloadError);
    expect(() =>
      parseVectorPayload(
        JSON.stringify({
          a: Array(MAX_VECTOR_LENGTH + 1).fill(1),
          b: Array(MAX_VECTOR_LENGTH + 1).fill(1),
        }),
      ),
    ).toThrow(VectorPayloadError);
  });

  test("declares vector as a hard capability rather than cpu", () => {
    expect(vectorDotHandler.taskType).toBe("vector");
    expect(vectorWorkerRegistry.workerType).toBe("vector");
    expect(vectorWorkerRegistry.resolve("vector.dot", "vector")).toBe(vectorDotHandler);
    expect(vectorWorkerRegistry.resolve("vector.dot", "cpu")).toBeUndefined();
  });
});

describe("vector worker configuration", () => {
  test("accepts loopback broker origins and rejects remote origins", () => {
    expect(normalizeVectorOrigin("http://127.0.0.1:7332")).toBe("http://127.0.0.1:7332");
    expect(normalizeVectorOrigin("http://localhost:7332/")).toBe("http://localhost:7332");
    expect(() => normalizeVectorOrigin("https://example.com:7332")).toThrow();
    expect(() => normalizeVectorOrigin("http://192.0.2.10:7332")).toThrow();
  });

  test("uses bounded reference defaults without treating them as engine limits", () => {
    const config = loadVectorWorkerConfig({ VECTOR_WORKER_OUTPUT_DIR: "/tmp/vector-results" });
    expect(config.origin).toBe("http://127.0.0.1:7332");
    expect(config.capacity).toBe(1);
    expect(config.pollMs).toBe(250);
    expect(config.outputDir).toBe("/tmp/vector-results");
  });
});
