import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkerHandler } from "./registry";

export const MAX_HASH_DATA_BYTES = 256 * 1024;
export type HashAlgorithm = "sha256" | "sha512";

interface HashPayload {
  data: string;
  algorithm: HashAlgorithm;
}

export interface HashResult {
  schema_version: 1;
  task_id: number;
  algorithm: HashAlgorithm;
  bytes: number;
  digest: string;
}

export class HashPayloadError extends Error {
  readonly code = "invalid_payload";
}

function parseHashPayload(raw: string): HashPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HashPayloadError("payload must be valid JSON");
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HashPayloadError("payload must be a JSON object");
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "data" && key !== "algorithm") {
      throw new HashPayloadError(`unsupported payload field: ${key}`);
    }
  }

  if (typeof record.data !== "string") {
    throw new HashPayloadError("payload.data must be a string");
  }
  if (record.algorithm !== "sha256" && record.algorithm !== "sha512") {
    throw new HashPayloadError("payload.algorithm must be sha256 or sha512");
  }

  const bytes = new TextEncoder().encode(record.data).byteLength;
  if (bytes > MAX_HASH_DATA_BYTES) {
    throw new HashPayloadError("payload.data exceeds the 256 KiB worker limit");
  }

  return { data: record.data, algorithm: record.algorithm };
}

export async function computeHash(taskId: number, rawPayload: string): Promise<HashResult> {
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    throw new Error("task id must be a positive safe integer");
  }

  const payload = parseHashPayload(rawPayload);
  const encoded = new TextEncoder().encode(payload.data);
  const subtleAlgorithm = payload.algorithm === "sha256" ? "SHA-256" : "SHA-512";
  const digestBytes = await crypto.subtle.digest(subtleAlgorithm, encoded);
  const digest = Array.from(new Uint8Array(digestBytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return {
    schema_version: 1,
    task_id: taskId,
    algorithm: payload.algorithm,
    bytes: encoded.byteLength,
    digest,
  };
}

async function writeHashResultAtomic(outputDir: string, result: HashResult): Promise<string> {
  if (outputDir.length === 0) {
    throw new Error("output directory must not be empty");
  }

  await mkdir(outputDir, { recursive: true });
  const finalPath = join(outputDir, `task-${result.task_id}.json`);
  const tempPath = join(outputDir, `.task-${result.task_id}.${crypto.randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, `${JSON.stringify(result)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return finalPath;
}

export const hashComputeHandler: WorkerHandler = {
  taskName: "hash.compute",
  taskType: "cpu",

  async handle(task, context) {
    const result = await computeHash(task.task_id, task.payload);
    await writeHashResultAtomic(context.outputDir, result);
    return result;
  },

  classifyError(error) {
    return error instanceof HashPayloadError ? "invalid_payload" : "processing_failed";
  },
};
