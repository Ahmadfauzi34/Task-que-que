import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_HASH_DATA_BYTES,
  HashPayloadError,
  computeHash,
  hashComputeHandler,
} from "../src/hash-handler";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("hash compute handler", () => {
  test("computes deterministic sha256 and sha512 metadata without copying source data", async () => {
    const sha256 = await computeHash(7, JSON.stringify({ data: "hello", algorithm: "sha256" }));
    const sha512 = await computeHash(8, JSON.stringify({ data: "hello", algorithm: "sha512" }));

    expect(sha256).toEqual({
      schema_version: 1,
      task_id: 7,
      algorithm: "sha256",
      bytes: 5,
      digest: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
    expect(sha512.algorithm).toBe("sha512");
    expect(sha512.digest).toMatch(/^[0-9a-f]{128}$/);
    expect(JSON.stringify(sha256)).not.toContain("hello");
    expect(JSON.stringify(sha512)).not.toContain("hello");
  });

  test("writes one deterministic task artifact through the registry handler", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hash-worker-test-"));
    cleanupPaths.push(dir);

    await hashComputeHandler.handle(
      {
        task_id: 11,
        task_name: "hash.compute",
        task_type: "cpu",
        payload: JSON.stringify({ data: "retry-safe", algorithm: "sha256" }),
      },
      { outputDir: dir },
    );
    await hashComputeHandler.handle(
      {
        task_id: 11,
        task_name: "hash.compute",
        task_type: "cpu",
        payload: JSON.stringify({ data: "retry-safe", algorithm: "sha256" }),
      },
      { outputDir: dir },
    );

    const stored = await readFile(join(dir, "task-11.json"), "utf8");
    expect(stored).toContain('"algorithm":"sha256"');
    expect(stored).toContain('"task_id":11');
    expect(stored).not.toContain("retry-safe");
  });

  test("fails closed on unknown fields, algorithms, and oversized data", async () => {
    await expect(computeHash(1, '{"data":"ok","algorithm":"md5"}')).rejects.toBeInstanceOf(
      HashPayloadError,
    );
    await expect(
      computeHash(1, '{"data":"ok","algorithm":"sha256","command":"rm"}'),
    ).rejects.toBeInstanceOf(HashPayloadError);
    await expect(
      computeHash(
        1,
        JSON.stringify({ data: "x".repeat(MAX_HASH_DATA_BYTES + 1), algorithm: "sha256" }),
      ),
    ).rejects.toBeInstanceOf(HashPayloadError);
  });
});
