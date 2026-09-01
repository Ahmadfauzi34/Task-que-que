import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RegistryTask, WorkerHandler } from "../../document-bun/src/registry";

export const MAX_WORKFLOW_PAYLOAD_BYTES = 256 * 1024;
export const MAX_WORKFLOW_STEPS = 32;

const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SAFE_TASK_TYPE = /^[A-Za-z0-9._:-]{1,128}$/;
const encoder = new TextEncoder();

export interface WorkflowStep {
  id: string;
  type: string;
  payload: unknown;
  depends_on: string[];
  priority?: number;
  max_retries?: number;
}

export interface WorkflowDefinition {
  steps: WorkflowStep[];
}

export interface WorkflowGatewayConfig {
  origin: string;
  bearerToken: string;
  requestTimeoutMs: number;
  pollMs: number;
  maxRunMs: number;
  fetchImpl?: typeof fetch;
}

export interface WorkflowResult {
  schema_version: 1;
  workflow_task_id: number;
  status: "COMPLETED";
  steps: Array<{
    id: string;
    type: string;
    task_id: number;
    status: "COMPLETED";
  }>;
}

interface ChildTaskSnapshot {
  id: number;
  task_name: string;
  status: "PENDING" | "ASSIGNED" | "RUNNING" | "COMPLETED" | "FAILED";
}

interface RuntimeStep {
  step: WorkflowStep;
  taskId: number | null;
  status: "WAITING" | ChildTaskSnapshot["status"];
}

export class WorkflowPayloadError extends Error {
  readonly code = "invalid_payload";
}

export class WorkflowExecutionError extends Error {
  readonly code = "processing_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeWorkflowGatewayOrigin(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1";

  if (url.protocol !== "http:" || !loopback) {
    throw new Error("WORKFLOW_GATEWAY_ORIGIN must be a loopback http origin");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("WORKFLOW_GATEWAY_ORIGIN must contain only scheme, host, and port");
  }
  return url.origin;
}

export function validateWorkflowGatewayConfig(
  config: WorkflowGatewayConfig,
): WorkflowGatewayConfig {
  const origin = normalizeWorkflowGatewayOrigin(config.origin);
  if (
    config.bearerToken.length === 0 ||
    config.bearerToken.length > 4096 ||
    /[\r\n]/.test(config.bearerToken)
  ) {
    throw new Error("WORKFLOW_GATEWAY_API_TOKEN is invalid");
  }
  if (
    !Number.isSafeInteger(config.requestTimeoutMs) ||
    config.requestTimeoutMs < 100 ||
    config.requestTimeoutMs > 60_000
  ) {
    throw new Error("WORKFLOW_GATEWAY_REQUEST_TIMEOUT_MS must be between 100 and 60000");
  }
  if (!Number.isSafeInteger(config.pollMs) || config.pollMs < 25 || config.pollMs > 60_000) {
    throw new Error("WORKFLOW_POLL_MS must be between 25 and 60000");
  }
  if (
    !Number.isSafeInteger(config.maxRunMs) ||
    config.maxRunMs < 1_000 ||
    config.maxRunMs > 86_400_000
  ) {
    throw new Error("WORKFLOW_MAX_RUN_MS must be between 1000 and 86400000");
  }
  return { ...config, origin };
}

export function parseWorkflowDefinition(raw: string): WorkflowDefinition {
  if (encoder.encode(raw).byteLength > MAX_WORKFLOW_PAYLOAD_BYTES) {
    throw new WorkflowPayloadError("workflow payload exceeds 256 KiB");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WorkflowPayloadError("workflow payload must be valid JSON");
  }
  if (!isRecord(value)) {
    throw new WorkflowPayloadError("workflow payload must be a JSON object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "steps") {
      throw new WorkflowPayloadError(`unsupported workflow field: ${key}`);
    }
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new WorkflowPayloadError("workflow.steps must contain at least one step");
  }
  if (value.steps.length > MAX_WORKFLOW_STEPS) {
    throw new WorkflowPayloadError(`workflow supports at most ${MAX_WORKFLOW_STEPS} steps`);
  }

  const ids = new Set<string>();
  const steps: WorkflowStep[] = value.steps.map((rawStep, index) => {
    if (!isRecord(rawStep)) {
      throw new WorkflowPayloadError(`workflow step ${index} must be a JSON object`);
    }
    for (const key of Object.keys(rawStep)) {
      if (
        key !== "id" &&
        key !== "type" &&
        key !== "payload" &&
        key !== "depends_on" &&
        key !== "priority" &&
        key !== "max_retries"
      ) {
        throw new WorkflowPayloadError(`unsupported workflow step field: ${key}`);
      }
    }
    if (typeof rawStep.id !== "string" || !SAFE_ID.test(rawStep.id)) {
      throw new WorkflowPayloadError(`workflow step ${index} has an invalid id`);
    }
    if (ids.has(rawStep.id)) {
      throw new WorkflowPayloadError(`duplicate workflow step id: ${rawStep.id}`);
    }
    ids.add(rawStep.id);

    if (typeof rawStep.type !== "string" || !SAFE_TASK_TYPE.test(rawStep.type)) {
      throw new WorkflowPayloadError(`workflow step ${rawStep.id} has an invalid task type`);
    }
    if (rawStep.type === "workflow.run") {
      throw new WorkflowPayloadError("recursive workflow.run steps are not supported in v1");
    }
    if (!Object.prototype.hasOwnProperty.call(rawStep, "payload")) {
      throw new WorkflowPayloadError(`workflow step ${rawStep.id} is missing payload`);
    }

    const dependsOnRaw = rawStep.depends_on ?? [];
    if (!Array.isArray(dependsOnRaw) || dependsOnRaw.length > MAX_WORKFLOW_STEPS) {
      throw new WorkflowPayloadError(`workflow step ${rawStep.id} has invalid depends_on`);
    }
    const dependsOn: string[] = [];
    const seenDependencies = new Set<string>();
    for (const dependency of dependsOnRaw) {
      if (typeof dependency !== "string" || !SAFE_ID.test(dependency)) {
        throw new WorkflowPayloadError(`workflow step ${rawStep.id} has an invalid dependency id`);
      }
      if (dependency === rawStep.id) {
        throw new WorkflowPayloadError(`workflow step ${rawStep.id} cannot depend on itself`);
      }
      if (seenDependencies.has(dependency)) {
        throw new WorkflowPayloadError(`workflow step ${rawStep.id} repeats dependency ${dependency}`);
      }
      seenDependencies.add(dependency);
      dependsOn.push(dependency);
    }

    if (rawStep.priority !== undefined && !Number.isSafeInteger(rawStep.priority)) {
      throw new WorkflowPayloadError(`workflow step ${rawStep.id} priority must be an integer`);
    }
    if (
      rawStep.max_retries !== undefined &&
      (!Number.isSafeInteger(rawStep.max_retries) || (rawStep.max_retries as number) < 0)
    ) {
      throw new WorkflowPayloadError(
        `workflow step ${rawStep.id} max_retries must be a non-negative integer`,
      );
    }

    return {
      id: rawStep.id,
      type: rawStep.type,
      payload: rawStep.payload,
      depends_on: dependsOn,
      ...(rawStep.priority !== undefined ? { priority: rawStep.priority as number } : {}),
      ...(rawStep.max_retries !== undefined
        ? { max_retries: rawStep.max_retries as number }
        : {}),
    };
  });

  const byId = new Map(steps.map((step) => [step.id, step] as const));
  for (const step of steps) {
    for (const dependency of step.depends_on) {
      if (!byId.has(dependency)) {
        throw new WorkflowPayloadError(
          `workflow step ${step.id} depends on unknown step ${dependency}`,
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): void => {
    if (visiting.has(stepId)) {
      throw new WorkflowPayloadError("workflow dependency graph contains a cycle");
    }
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    const step = byId.get(stepId);
    if (!step) throw new WorkflowPayloadError(`unknown workflow step ${stepId}`);
    for (const dependency of step.depends_on) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of steps) visit(step.id);

  return { steps };
}

interface GatewayJsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function gatewayJson(
  config: WorkflowGatewayConfig,
  path: string,
  init: RequestInit,
): Promise<GatewayJsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const fetchImpl = config.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${config.origin}${path}`, {
      ...init,
      signal: controller.signal,
    });
    const raw = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new WorkflowExecutionError("gateway returned invalid JSON");
    }
    if (!isRecord(body)) {
      throw new WorkflowExecutionError("gateway returned a non-object response");
    }
    return { status: response.status, body };
  } catch (error) {
    if (error instanceof WorkflowPayloadError || error instanceof WorkflowExecutionError) {
      throw error;
    }
    throw new WorkflowExecutionError(
      `gateway request failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function gatewayHeaders(config: WorkflowGatewayConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.bearerToken}`,
    "Content-Type": "application/json",
  };
}

function childIdempotencyKey(workflowTaskId: number, stepId: string): string {
  return `wf-${workflowTaskId}-${stepId}`;
}

async function enqueueChild(
  workflowTaskId: number,
  step: WorkflowStep,
  config: WorkflowGatewayConfig,
): Promise<{ taskId: number; replayed: boolean }> {
  const response = await gatewayJson(config, "/v1/tasks", {
    method: "POST",
    headers: {
      ...gatewayHeaders(config),
      "Idempotency-Key": childIdempotencyKey(workflowTaskId, step.id),
    },
    body: JSON.stringify({
      type: step.type,
      payload: step.payload,
      ...(step.priority !== undefined ? { priority: step.priority } : {}),
      ...(step.max_retries !== undefined ? { max_retries: step.max_retries } : {}),
    }),
  });

  if (response.status === 400 || response.status === 413 || response.status === 422) {
    throw new WorkflowPayloadError(`gateway rejected workflow step ${step.id}`);
  }
  if (response.status !== 202) {
    throw new WorkflowExecutionError(
      `gateway could not enqueue workflow step ${step.id}: HTTP ${response.status}`,
    );
  }
  if (
    !Number.isSafeInteger(response.body.task_id) ||
    (response.body.task_id as number) <= 0 ||
    response.body.status !== "PENDING" ||
    typeof response.body.replayed !== "boolean"
  ) {
    throw new WorkflowExecutionError("gateway returned an invalid child task response");
  }
  return {
    taskId: response.body.task_id as number,
    replayed: response.body.replayed as boolean,
  };
}

async function getChild(
  taskId: number,
  expectedTaskName: string,
  config: WorkflowGatewayConfig,
): Promise<ChildTaskSnapshot> {
  const response = await gatewayJson(config, `/v1/tasks/${taskId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${config.bearerToken}` },
  });
  if (response.status !== 200) {
    throw new WorkflowExecutionError(`gateway could not query child task ${taskId}`);
  }
  const status = response.body.status;
  if (
    !Number.isSafeInteger(response.body.id) ||
    response.body.id !== taskId ||
    response.body.task_name !== expectedTaskName ||
    (status !== "PENDING" &&
      status !== "ASSIGNED" &&
      status !== "RUNNING" &&
      status !== "COMPLETED" &&
      status !== "FAILED")
  ) {
    throw new WorkflowExecutionError(`gateway returned an invalid child snapshot for ${taskId}`);
  }
  return {
    id: taskId,
    task_name: expectedTaskName,
    status,
  };
}

export async function executeWorkflow(
  workflowTaskId: number,
  rawPayload: string,
  rawConfig: WorkflowGatewayConfig,
): Promise<WorkflowResult> {
  if (!Number.isSafeInteger(workflowTaskId) || workflowTaskId <= 0) {
    throw new Error("workflow task id must be a positive safe integer");
  }
  const definition = parseWorkflowDefinition(rawPayload);
  const config = validateWorkflowGatewayConfig(rawConfig);
  const runtime = new Map<string, RuntimeStep>(
    definition.steps.map((step) => [
      step.id,
      { step, taskId: null, status: "WAITING" as const },
    ]),
  );
  const startedAt = Date.now();

  while (true) {
    if (Date.now() - startedAt > config.maxRunMs) {
      throw new WorkflowExecutionError("workflow exceeded configured maximum run time");
    }

    for (const current of runtime.values()) {
      if (current.taskId === null || current.status === "COMPLETED") continue;
      const snapshot = await getChild(current.taskId, current.step.type, config);
      current.status = snapshot.status;
      if (snapshot.status === "FAILED") {
        throw new WorkflowExecutionError(`workflow child step ${current.step.id} failed`);
      }
    }

    for (const current of runtime.values()) {
      if (current.taskId !== null) continue;
      const ready = current.step.depends_on.every(
        (dependency) => runtime.get(dependency)?.status === "COMPLETED",
      );
      if (!ready) continue;

      const child = await enqueueChild(workflowTaskId, current.step, config);
      current.taskId = child.taskId;
      current.status = "PENDING";
      console.log(
        `workflow child submitted parent=${workflowTaskId} step=${current.step.id} task=${child.taskId} replayed=${child.replayed}`,
      );
    }

    const completed = Array.from(runtime.values()).every(
      (current) => current.status === "COMPLETED",
    );
    if (completed) {
      return {
        schema_version: 1,
        workflow_task_id: workflowTaskId,
        status: "COMPLETED",
        steps: definition.steps.map((step) => {
          const current = runtime.get(step.id);
          if (!current || current.taskId === null || current.status !== "COMPLETED") {
            throw new WorkflowExecutionError("workflow runtime lost a completed child task");
          }
          return {
            id: step.id,
            type: step.type,
            task_id: current.taskId,
            status: "COMPLETED" as const,
          };
        }),
      };
    }

    await sleep(config.pollMs);
  }
}

export async function writeWorkflowResultAtomic(
  outputDir: string,
  result: WorkflowResult,
): Promise<string> {
  if (outputDir.length === 0 || outputDir.includes("\0")) {
    throw new Error("output directory is invalid");
  }
  await mkdir(outputDir, { recursive: true });
  const finalPath = join(outputDir, `task-${result.workflow_task_id}.json`);
  const tempPath = join(
    outputDir,
    `.task-${result.workflow_task_id}.${crypto.randomUUID()}.tmp`,
  );
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

export function createWorkflowHandler(config: WorkflowGatewayConfig): WorkerHandler {
  const validated = validateWorkflowGatewayConfig(config);
  return {
    taskName: "workflow.run",
    taskType: "workflow",

    async handle(task: RegistryTask, context) {
      const result = await executeWorkflow(task.task_id, task.payload, validated);
      await writeWorkflowResultAtomic(context.outputDir, result);
    },

    classifyError(error) {
      return error instanceof WorkflowPayloadError ? "invalid_payload" : "processing_failed";
    },
  };
}
