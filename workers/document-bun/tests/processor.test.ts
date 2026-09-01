import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_DOCUMENT_TEXT_BYTES,
  DocumentPayloadError,
  parseDocumentPayload,
  processDocument,
  writeDocumentResultAtomic,
} from "../src/processor";
import { loadWorkerConfig, normalizeLoopbackOrigin } from "../src/worker";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("document processor", () => {
  test("produces deterministic metadata without copying source text", async () => {
    const raw = JSON.stringify({
      document_id: "doc-1",
      text: "hello world\nfrom worker",
    });
    const first = await processDocument(7, raw);
    const second = await processDocument(7, raw);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schema_version: 1,
      task_id: 7,
      document_id: "doc-1",
      bytes: 23,
      characters: 23,
      lines: 2,
      words: 4,
    });
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(first)).not.toContain("hello world");
  });

  test("writes one deterministic task file atomically and can overwrite on retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "document-worker-test-"));
    cleanupPaths.push(dir);
    const result = await processDocument(
      11,
      JSON.stringify({ text: "retry-safe", document_id: "retry-doc" }),
    );

    const firstPath = await writeDocumentResultAtomic(dir, result);
    const secondPath = await writeDocumentResultAtomic(dir, result);
    expect(firstPath).toBe(secondPath);

    const stored = JSON.parse(await readFile(firstPath, "utf8"));
    expect(stored).toEqual(result);
    expect(await readFile(firstPath, "utf8")).not.toContain("retry-safe");
  });

  test("fails closed on unknown fields, invalid ids, and oversized text", () => {
    expect(() => parseDocumentPayload('{"text":"ok","command":"rm"}')).toThrow(
      DocumentPayloadError,
    );
    expect(() => parseDocumentPayload('{"text":"ok","document_id":"../escape"}')).toThrow(
      DocumentPayloadError,
    );
    expect(() =>
      parseDocumentPayload(JSON.stringify({ text: "x".repeat(MAX_DOCUMENT_TEXT_BYTES + 1) })),
    ).toThrow(DocumentPayloadError);
  });
});

describe("worker configuration", () => {
  test("accepts loopback broker origins and rejects remote origins", () => {
    expect(normalizeLoopbackOrigin("http://127.0.0.1:7332")).toBe("http://127.0.0.1:7332");
    expect(normalizeLoopbackOrigin("http://localhost:7332/")).toBe("http://localhost:7332");
    expect(() => normalizeLoopbackOrigin("https://example.com:7332")).toThrow();
    expect(() => normalizeLoopbackOrigin("http://192.0.2.10:7332")).toThrow();
  });

  test("uses bounded reference defaults rather than intrinsic engine limits", () => {
    const config = loadWorkerConfig({ DOCUMENT_WORKER_OUTPUT_DIR: "/tmp/results" });
    expect(config.origin).toBe("http://127.0.0.1:7332");
    expect(config.capacity).toBe(1);
    expect(config.pollMs).toBe(250);
    expect(config.outputDir).toBe("/tmp/results");
  });
});
