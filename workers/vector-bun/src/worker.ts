import { WorkerHandlerRegistry } from "../../document-bun/src/registry";
import { runWorker, type WorkerConfig } from "../../document-bun/src/worker";
import { vectorDotHandler } from "./vector-handler";

export const vectorWorkerRegistry = new WorkerHandlerRegistry("vector", [vectorDotHandler]);

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  max: number,
): number {
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function nonNegativeInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  max: number,
): number {
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}`);
  }
  return value;
}

export function normalizeVectorOrigin(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1";

  if (url.protocol !== "http:" || !loopback) {
    throw new Error("VECTOR_WORKER_ORIGIN must be a loopback http origin");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("VECTOR_WORKER_ORIGIN must contain only scheme, host, and port");
  }

  return url.origin;
}

export function loadVectorWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig {
  const workerId = env.VECTOR_WORKER_ID ?? "vector-reference-worker";
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(workerId)) {
    throw new Error("VECTOR_WORKER_ID must be a safe 1-128 character identifier");
  }

  const outputDir = env.VECTOR_WORKER_OUTPUT_DIR ?? "./var/vector-worker-results";
  if (outputDir.length === 0 || outputDir.includes("\0")) {
    throw new Error("VECTOR_WORKER_OUTPUT_DIR is invalid");
  }

  return {
    origin: normalizeVectorOrigin(env.VECTOR_WORKER_ORIGIN ?? "http://127.0.0.1:7332"),
    workerId,
    outputDir,
    capacity: positiveInteger(env.VECTOR_WORKER_CAPACITY, 1, "VECTOR_WORKER_CAPACITY", 64),
    pollMs: positiveInteger(env.VECTOR_WORKER_POLL_MS, 250, "VECTOR_WORKER_POLL_MS", 60_000),
    processDelayMs: nonNegativeInteger(
      env.VECTOR_WORKER_PROCESS_DELAY_MS,
      0,
      "VECTOR_WORKER_PROCESS_DELAY_MS",
      60_000,
    ),
    requestTimeoutMs: positiveInteger(
      env.VECTOR_WORKER_REQUEST_TIMEOUT_MS,
      5_000,
      "VECTOR_WORKER_REQUEST_TIMEOUT_MS",
      60_000,
    ),
  };
}

if (import.meta.main) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  runWorker(loadVectorWorkerConfig(), controller.signal, vectorWorkerRegistry).catch((error) => {
    console.error(
      `reference vector worker fatal: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
