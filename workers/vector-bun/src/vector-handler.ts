import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkerHandler } from "../../document-bun/src/registry";

export const MAX_VECTOR_LENGTH = 4096;
export const MAX_VECTOR_ELEMENT_ABS = 1_000_000;
export const MAX_VECTOR_PAYLOAD_BYTES = 256 * 1024;

interface VectorPayload {
  a: number[];
  b: number[];
}

export interface VectorDotResult {
  schema_version: 1;
  task_id: number;
  length: number;
  dot: number;
}

export class VectorPayloadError extends Error {
  readonly code = "invalid_payload";
}

function validateVector(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) {
    throw new VectorPayloadError(`payload.${label} must be an array`);
  }
  if (value.length === 0 || value.length > MAX_VECTOR_LENGTH) {
    throw new VectorPayloadError(
      `payload.${label} length must be between 1 and ${MAX_VECTOR_LENGTH}`,
    );
  }

  return value.map((entry, index) => {
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      Math.abs(entry) > MAX_VECTOR_ELEMENT_ABS
    ) {
      throw new VectorPayloadError(
        `payload.${label}[${index}] must be a safe integer between -${MAX_VECTOR_ELEMENT_ABS} and ${MAX_VECTOR_ELEMENT_ABS}`,
      );
    }
    return entry;
  });
}

export function parseVectorPayload(raw: string): VectorPayload {
  if (new TextEncoder().encode(raw).byteLength > MAX_VECTOR_PAYLOAD_BYTES) {
    throw new VectorPayloadError("payload exceeds the 256 KiB reference worker limit");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new VectorPayloadError("payload must be valid JSON");
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VectorPayloadError("payload must be a JSON object");
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "a" && key !== "b") {
      throw new VectorPayloadError(`unsupported payload field: ${key}`);
    }
  }

  const a = validateVector(record.a, "a");
  const b = validateVector(record.b, "b");
  if (a.length !== b.length) {
    throw new VectorPayloadError("payload.a and payload.b must have the same length");
  }

  return { a, b };
}

export function computeVectorDot(taskId: number, rawPayload: string): VectorDotResult {
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    throw new Error("task id must be a positive safe integer");
  }

  const payload = parseVectorPayload(rawPayload);
  let dot = 0;
  for (let index = 0; index < payload.a.length; index += 1) {
    dot += payload.a[index]! * payload.b[index]!;
  }

  if (!Number.isSafeInteger(dot)) {
    throw new Error("bounded vector dot result exceeded safe integer range");
  }

  return {
    schema_version: 1,
    task_id: taskId,
    length: payload.a.length,
    dot,
  };
}

export async function writeVectorResultAtomic(
  outputDir: string,
  result: VectorDotResult,
): Promise<string> {
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

export const vectorDotHandler: WorkerHandler = {
  taskName: "vector.dot",
  taskType: "vector",

  async handle(task, context) {
    const result = computeVectorDot(task.task_id, task.payload);
    await writeVectorResultAtomic(context.outputDir, result);
    return result;
  },

  classifyError(error) {
    return error instanceof VectorPayloadError ? "invalid_payload" : "processing_failed";
  },
};
