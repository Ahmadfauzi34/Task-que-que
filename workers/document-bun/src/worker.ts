import { documentProcessHandler } from "./document-handler";
import { hashComputeHandler } from "./hash-handler";
import { WorkerHandlerRegistry, type RegistryTask } from "./registry";

export const MAX_RESULT_PROJECTION_BYTES = 256 * 1024;

export const referenceWorkerRegistry = new WorkerHandlerRegistry("cpu", [
  documentProcessHandler,
  hashComputeHandler,
]);

export interface WorkerConfig {
  origin: string;
  workerId: string;
  outputDir: string;
  capacity: number;
  pollMs: number;
  processDelayMs: number;
  requestTimeoutMs: number;
}

interface Registration {
  worker_id: string;
  worker_type: string;
  capacity: number;
  session_id: string;
  session_token: string;
  session_ttl_ms: number;
  task_lease_ms: number;
}

interface ClaimedTask extends RegistryTask {
  retry_count: number;
  max_retries: number;
  lease_generation: number;
  lease_ms: number;
}

class WorkerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

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

export function normalizeLoopbackOrigin(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1";

  if (url.protocol !== "http:" || !loopback) {
    throw new Error("DOCUMENT_WORKER_ORIGIN must be a loopback http origin");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("DOCUMENT_WORKER_ORIGIN must contain only scheme, host, and port");
  }

  return url.origin;
}

export function loadWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig {
  const workerId = env.DOCUMENT_WORKER_ID ?? "document-reference-worker";
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(workerId)) {
    throw new Error("DOCUMENT_WORKER_ID must be a safe 1-128 character identifier");
  }

  const outputDir = env.DOCUMENT_WORKER_OUTPUT_DIR ?? "./var/document-worker-results";
  if (outputDir.length === 0 || outputDir.includes("\0")) {
    throw new Error("DOCUMENT_WORKER_OUTPUT_DIR is invalid");
  }

  return {
    origin: normalizeLoopbackOrigin(
      env.DOCUMENT_WORKER_ORIGIN ?? "http://127.0.0.1:7332",
    ),
    workerId,
    outputDir,
    capacity: positiveInteger(env.DOCUMENT_WORKER_CAPACITY, 1, "DOCUMENT_WORKER_CAPACITY", 64),
    pollMs: positiveInteger(env.DOCUMENT_WORKER_POLL_MS, 250, "DOCUMENT_WORKER_POLL_MS", 60_000),
    processDelayMs: nonNegativeInteger(
      env.DOCUMENT_WORKER_PROCESS_DELAY_MS,
      0,
      "DOCUMENT_WORKER_PROCESS_DELAY_MS",
      60_000,
    ),
    requestTimeoutMs: positiveInteger(
      env.DOCUMENT_WORKER_REQUEST_TIMEOUT_MS,
      5_000,
      "DOCUMENT_WORKER_REQUEST_TIMEOUT_MS",
      60_000,
    ),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function serializeResultProjection(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("worker result projection must be a JSON object");
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(
      `worker result projection is not JSON serializable: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_RESULT_PROJECTION_BYTES) {
    throw new Error("worker result projection exceeds 256 KiB");
  }

  const roundTrip = JSON.parse(serialized) as unknown;
  if (roundTrip === null || typeof roundTrip !== "object" || Array.isArray(roundTrip)) {
    throw new Error("worker result projection must serialize to a JSON object");
  }
  return serialized;
}

async function workerRequest(
  config: WorkerConfig,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    return await fetch(`${config.origin}${path}`, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(
      `worker broker request failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new WorkerApiError(response.status, `worker broker returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function sessionHeaders(registration: Registration): HeadersInit {
  return {
    "X-Worker-Session": registration.session_id,
    "X-Worker-Token": registration.session_token,
  };
}

async function register(
  config: WorkerConfig,
  registry: WorkerHandlerRegistry,
): Promise<Registration> {
  const response = await workerRequest(config, "/v1/register", {
    method: "POST",
    headers: {
      "X-Worker-Id": config.workerId,
      "X-Worker-Type": registry.workerType,
      "X-Worker-Capacity": String(config.capacity),
    },
  });
  const registration = await responseJson<Registration>(response);

  if (
    registration.worker_id !== config.workerId ||
    registration.worker_type !== registry.workerType ||
    !/^[0-9a-f]{32}$/i.test(registration.session_id) ||
    !/^[0-9a-f]{64}$/i.test(registration.session_token) ||
    !Number.isSafeInteger(registration.session_ttl_ms) ||
    registration.session_ttl_ms <= 0 ||
    !Number.isSafeInteger(registration.task_lease_ms) ||
    registration.task_lease_ms <= 0
  ) {
    throw new Error("worker broker returned a malformed registration");
  }

  return registration;
}

async function heartbeatSession(
  config: WorkerConfig,
  registration: Registration,
): Promise<void> {
  const response = await workerRequest(config, "/v1/session/heartbeat", {
    method: "POST",
    headers: sessionHeaders(registration),
  });
  if (!response.ok) {
    throw new WorkerApiError(response.status, `session heartbeat returned HTTP ${response.status}`);
  }
}

async function claimTask(
  config: WorkerConfig,
  registration: Registration,
): Promise<ClaimedTask | null> {
  const response = await workerRequest(config, "/v1/claim", {
    method: "POST",
    headers: sessionHeaders(registration),
  });
  if (response.status === 204) {
    return null;
  }
  const task = await responseJson<ClaimedTask>(response);
  if (
    !Number.isSafeInteger(task.task_id) ||
    task.task_id <= 0 ||
    typeof task.task_name !== "string" ||
    typeof task.task_type !== "string" ||
    typeof task.payload !== "string" ||
    !Number.isSafeInteger(task.lease_generation) ||
    task.lease_generation <= 0 ||
    !Number.isSafeInteger(task.lease_ms) ||
    task.lease_ms <= 0
  ) {
    throw new Error("worker broker returned a malformed claim");
  }
  return task;
}

async function taskTransition(
  config: WorkerConfig,
  registration: Registration,
  task: ClaimedTask,
  path: "/v1/task/heartbeat" | "/v1/task/complete" | "/v1/task/fail",
  errorCode?: string,
  resultProjection?: string,
): Promise<void> {
  const headers: Record<string, string> = {
    ...(sessionHeaders(registration) as Record<string, string>),
    "X-Task-Id": String(task.task_id),
    "X-Lease-Generation": String(task.lease_generation),
  };
  if (errorCode !== undefined) {
    headers["X-Worker-Error-Code"] = errorCode;
  }
  if (resultProjection !== undefined) {
    if (path !== "/v1/task/complete") {
      throw new Error("result projection is only valid for task completion");
    }
    headers["Content-Type"] = "application/json; charset=utf-8";
  }

  const response = await workerRequest(config, path, {
    method: "POST",
    headers,
    ...(resultProjection !== undefined ? { body: resultProjection } : {}),
  });
  if (!response.ok) {
    throw new WorkerApiError(response.status, `${path} returned HTTP ${response.status}`);
  }
}

async function failClaim(
  config: WorkerConfig,
  registration: Registration,
  task: ClaimedTask,
  errorCode: string,
): Promise<void> {
  try {
    await taskTransition(config, registration, task, "/v1/task/fail", errorCode);
  } catch (error) {
    console.error(
      `document worker could not fail task ${task.task_id}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

async function handleClaim(
  config: WorkerConfig,
  registration: Registration,
  task: ClaimedTask,
  registry: WorkerHandlerRegistry,
): Promise<void> {
  const handler = registry.resolve(task.task_name, task.task_type);
  if (handler === undefined) {
    await failClaim(config, registration, task, "unsupported_task");
    return;
  }

  const heartbeatController = new AbortController();
  let leaseLost = false;
  const heartbeatEveryMs = Math.max(
    50,
    Math.min(
      Math.floor(task.lease_ms / 3),
      Math.floor(registration.session_ttl_ms / 3),
    ),
  );

  const heartbeatLoop = (async () => {
    while (!heartbeatController.signal.aborted) {
      await sleep(heartbeatEveryMs, heartbeatController.signal);
      if (heartbeatController.signal.aborted) {
        break;
      }
      try {
        await heartbeatSession(config, registration);
        await taskTransition(config, registration, task, "/v1/task/heartbeat");
      } catch (error) {
        leaseLost = true;
        heartbeatController.abort();
        console.error(
          `document worker lost lease for task ${task.task_id}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
  })();

  let resultProjection: string | undefined;
  try {
    if (config.processDelayMs > 0) {
      await sleep(config.processDelayMs);
    }
    const result = await handler.handle(task, { outputDir: config.outputDir });
    resultProjection = serializeResultProjection(result);
  } catch (error) {
    heartbeatController.abort();
    await heartbeatLoop;
    if (!leaseLost) {
      await failClaim(
        config,
        registration,
        task,
        handler.classifyError?.(error) ?? "processing_failed",
      );
    }
    return;
  }

  heartbeatController.abort();
  await heartbeatLoop;
  if (leaseLost) {
    return;
  }

  try {
    await taskTransition(
      config,
      registration,
      task,
      "/v1/task/complete",
      undefined,
      resultProjection,
    );
    console.log(`document worker completed task ${task.task_id}`);
  } catch (error) {
    console.error(
      `document worker completion failed for task ${task.task_id}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

export async function runWorker(
  config: WorkerConfig,
  stopSignal?: AbortSignal,
  registry: WorkerHandlerRegistry = referenceWorkerRegistry,
): Promise<void> {
  let registration = await register(config, registry);
  let lastSessionHeartbeat = Date.now();
  console.log(
    `reference document worker registered: id=${config.workerId} session=${registration.session_id}`,
  );

  while (!stopSignal?.aborted) {
    const heartbeatDueMs = Math.max(250, Math.floor(registration.session_ttl_ms / 3));
    if (Date.now() - lastSessionHeartbeat >= heartbeatDueMs) {
      try {
        await heartbeatSession(config, registration);
        lastSessionHeartbeat = Date.now();
      } catch (error) {
        if (error instanceof WorkerApiError && error.status === 401) {
          registration = await register(config, registry);
          lastSessionHeartbeat = Date.now();
          continue;
        }
        console.error(
          `document worker session heartbeat failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        await sleep(config.pollMs, stopSignal);
        continue;
      }
    }

    let task: ClaimedTask | null;
    try {
      task = await claimTask(config, registration);
    } catch (error) {
      if (error instanceof WorkerApiError && error.status === 401) {
        registration = await register(config, registry);
        lastSessionHeartbeat = Date.now();
        continue;
      }
      console.error(
        `document worker claim failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      await sleep(config.pollMs, stopSignal);
      continue;
    }

    if (task === null) {
      await sleep(config.pollMs, stopSignal);
      continue;
    }

    await handleClaim(config, registration, task, registry);
    lastSessionHeartbeat = Date.now();
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  runWorker(loadWorkerConfig(), controller.signal).catch((error) => {
    console.error(
      `reference document worker fatal: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
