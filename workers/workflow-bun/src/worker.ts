import {
  WorkerHandlerRegistry,
  type WorkerHandler,
} from "../../document-bun/src/registry";
import { runWorker, type WorkerConfig } from "../../document-bun/src/worker";
import { executeWorkflowWithDeclaredOutputs } from "./declared-outputs";
import {
  WorkflowPayloadError,
  validateWorkflowGatewayConfig,
  writeWorkflowResultAtomic,
  type WorkflowGatewayConfig,
} from "./workflow-handler";

export interface WorkflowWorkerConfig {
  worker: WorkerConfig;
  workflow: WorkflowGatewayConfig;
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  max: number,
): number {
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function normalizeLoopbackOrigin(raw: string, name: string): string {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1";
  if (url.protocol !== "http:" || !loopback) {
    throw new Error(`${name} must be a loopback http origin`);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(`${name} must contain only scheme, host, and port`);
  }
  return url.origin;
}

function cancellationAwareFetch(
  fetchImpl: typeof fetch | undefined,
  taskSignal: AbortSignal,
): typeof fetch {
  const base = fetchImpl ?? fetch;
  return (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (taskSignal.aborted) {
      throw taskSignal.reason ?? new DOMException("operation aborted", "AbortError");
    }

    const controller = new AbortController();
    const callerSignal = init?.signal ?? undefined;
    const abortFromTask = () => controller.abort(taskSignal.reason);
    const abortFromCaller = () => controller.abort(callerSignal?.reason);

    taskSignal.addEventListener("abort", abortFromTask, { once: true });
    if (callerSignal?.aborted) {
      abortFromCaller();
    } else {
      callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    try {
      return await base(input, { ...init, signal: controller.signal });
    } finally {
      taskSignal.removeEventListener("abort", abortFromTask);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }) as typeof fetch;
}

export function loadWorkflowWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): WorkflowWorkerConfig {
  const workerId = env.WORKFLOW_WORKER_ID ?? "workflow-reference-worker";
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(workerId)) {
    throw new Error("WORKFLOW_WORKER_ID must be a safe 1-128 character identifier");
  }

  const outputDir = env.WORKFLOW_WORKER_OUTPUT_DIR ?? "./var/workflow-worker-results";
  if (outputDir.length === 0 || outputDir.includes("\0")) {
    throw new Error("WORKFLOW_WORKER_OUTPUT_DIR is invalid");
  }

  const gatewayToken = env.WORKFLOW_GATEWAY_API_TOKEN ?? "";
  if (gatewayToken.length === 0) {
    throw new Error("WORKFLOW_GATEWAY_API_TOKEN is required");
  }

  return {
    worker: {
      origin: normalizeLoopbackOrigin(
        env.WORKFLOW_WORKER_ORIGIN ?? "http://127.0.0.1:7332",
        "WORKFLOW_WORKER_ORIGIN",
      ),
      workerId,
      outputDir,
      capacity: positiveInteger(env.WORKFLOW_WORKER_CAPACITY, 1, "WORKFLOW_WORKER_CAPACITY", 16),
      pollMs: positiveInteger(env.WORKFLOW_WORKER_POLL_MS, 250, "WORKFLOW_WORKER_POLL_MS", 60_000),
      processDelayMs: 0,
      requestTimeoutMs: positiveInteger(
        env.WORKFLOW_WORKER_REQUEST_TIMEOUT_MS,
        5_000,
        "WORKFLOW_WORKER_REQUEST_TIMEOUT_MS",
        60_000,
      ),
    },
    workflow: {
      origin: normalizeLoopbackOrigin(
        env.WORKFLOW_GATEWAY_ORIGIN ?? "http://127.0.0.1:3000",
        "WORKFLOW_GATEWAY_ORIGIN",
      ),
      resultOrigin: normalizeLoopbackOrigin(
        env.WORKFLOW_RESULT_ORIGIN ?? "http://127.0.0.1:7331",
        "WORKFLOW_RESULT_ORIGIN",
      ),
      bearerToken: gatewayToken,
      requestTimeoutMs: positiveInteger(
        env.WORKFLOW_GATEWAY_REQUEST_TIMEOUT_MS,
        5_000,
        "WORKFLOW_GATEWAY_REQUEST_TIMEOUT_MS",
        60_000,
      ),
      pollMs: positiveInteger(env.WORKFLOW_POLL_MS, 100, "WORKFLOW_POLL_MS", 60_000),
      maxRunMs: positiveInteger(
        env.WORKFLOW_MAX_RUN_MS,
        600_000,
        "WORKFLOW_MAX_RUN_MS",
        86_400_000,
      ),
    },
  };
}

export function createWorkflowWorkerRegistry(
  config: WorkflowGatewayConfig,
): WorkerHandlerRegistry {
  const validated = validateWorkflowGatewayConfig(config);
  const handler: WorkerHandler = {
    taskName: "workflow.run",
    taskType: "workflow",

    async handle(task, context) {
      const cancellableConfig: WorkflowGatewayConfig = {
        ...validated,
        fetchImpl: cancellationAwareFetch(validated.fetchImpl, context.signal),
        resultFetchImpl: cancellationAwareFetch(validated.resultFetchImpl, context.signal),
      };
      const result = await executeWorkflowWithDeclaredOutputs(
        task.task_id,
        task.payload,
        cancellableConfig,
      );
      await writeWorkflowResultAtomic(context.outputDir, result);
      return result;
    },

    classifyError(error) {
      return error instanceof WorkflowPayloadError ? "invalid_payload" : "processing_failed";
    },
  };
  return new WorkerHandlerRegistry("workflow", [handler]);
}

if (import.meta.main) {
  const config = loadWorkflowWorkerConfig();
  const registry = createWorkflowWorkerRegistry(config.workflow);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  runWorker(config.worker, controller.signal, registry).catch((error) => {
    console.error(
      `reference workflow worker fatal: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
