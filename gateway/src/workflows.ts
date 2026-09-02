import {
  GATEWAY_VERSION,
  MAX_PUBLIC_REQUEST_BYTES,
  handleRequest,
  type FetchLike,
  type GatewayDependencies,
} from "./app";

const encoder = new TextEncoder();
const MAX_WORKFLOW_RESULT_BYTES = 256 * 1024;
const MAX_WORKFLOW_STEPS = 32;
const SAFE_STEP_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SAFE_TASK_TYPE = /^[A-Za-z0-9._:-]{1,128}$/;

function jsonResponse(value: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-gateway-version", GATEWAY_VERSION);
  return new Response(`${JSON.stringify(value)}\n`, { status, headers });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copyHeader(source: Request, target: Headers, name: string): void {
  const value = source.headers.get(name);
  if (value !== null) target.set(name, value);
}

async function parseWorkflowBody(request: Request): Promise<unknown | Response> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return errorResponse(415, "unsupported_media_type", "content-type must be application/json");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isInteger(length) || length < 0) {
      return errorResponse(400, "invalid_content_length", "invalid content-length");
    }
    if (length > MAX_PUBLIC_REQUEST_BYTES) {
      return errorResponse(413, "request_too_large", "request body exceeds 1 MiB");
    }
  }

  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_PUBLIC_REQUEST_BYTES) {
    return errorResponse(413, "request_too_large", "request body exceeds 1 MiB");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse(400, "invalid_json", "request body must contain valid JSON");
  }
  if (!isRecord(parsed)) {
    return errorResponse(400, "invalid_workflow", "workflow body must be a JSON object");
  }
  return parsed;
}

function taskFacadeRequest(
  source: Request,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Request {
  const headers = new Headers();
  copyHeader(source, headers, "authorization");
  copyHeader(source, headers, "idempotency-key");
  if (method === "POST") headers.set("content-type", "application/json");

  return new Request(`http://gateway.internal${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function handleCreateWorkflow(
  request: Request,
  dependencies: GatewayDependencies,
): Promise<Response> {
  const workflow = await parseWorkflowBody(request);
  if (workflow instanceof Response) return workflow;

  const delegated = await handleRequest(
    taskFacadeRequest(request, "/v1/tasks", "POST", {
      type: "workflow.run",
      payload: workflow,
    }),
    dependencies,
  );
  if (delegated.status !== 202) return delegated;

  let body: unknown;
  try {
    body = await delegated.json();
  } catch {
    return errorResponse(502, "invalid_gateway_response", "task facade returned invalid JSON");
  }
  if (
    !isRecord(body) ||
    !Number.isSafeInteger(body.task_id) ||
    (body.task_id as number) <= 0 ||
    body.status !== "PENDING" ||
    typeof body.replayed !== "boolean"
  ) {
    return errorResponse(502, "invalid_gateway_response", "task facade returned invalid workflow state");
  }

  const workflowId = body.task_id as number;
  const headers = new Headers({ location: `/v1/workflows/${workflowId}` });
  if (delegated.headers.get("idempotency-replayed") === "true") {
    headers.set("idempotency-replayed", "true");
  }
  return jsonResponse(
    { workflow_id: workflowId, status: "PENDING", replayed: body.replayed },
    202,
    headers,
  );
}

type WorkflowStatus =
  | "PENDING"
  | "ASSIGNED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

interface WorkflowSnapshot {
  workflowId: number;
  status: WorkflowStatus;
  retryCount: number | null;
  createdAt: unknown;
  updatedAt: unknown;
}

function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return (
    value === "PENDING" ||
    value === "ASSIGNED" ||
    value === "RUNNING" ||
    value === "COMPLETED" ||
    value === "FAILED" ||
    value === "CANCELLED"
  );
}

async function readWorkflowSnapshot(
  request: Request,
  taskIdText: string,
  dependencies: GatewayDependencies,
): Promise<WorkflowSnapshot | Response> {
  if (!/^[1-9][0-9]*$/.test(taskIdText)) {
    return errorResponse(400, "invalid_workflow_id", "workflow id must be a positive integer");
  }

  const delegated = await handleRequest(
    taskFacadeRequest(request, `/v1/tasks/${taskIdText}`, "GET"),
    dependencies,
  );
  if (delegated.status === 404) {
    return errorResponse(404, "workflow_not_found", "workflow not found");
  }
  if (delegated.status !== 200) return delegated;

  let body: unknown;
  try {
    body = await delegated.json();
  } catch {
    return errorResponse(502, "invalid_gateway_response", "task facade returned invalid JSON");
  }
  if (!isRecord(body) || body.task_name !== "workflow.run" || body.task_type !== "workflow") {
    return errorResponse(404, "workflow_not_found", "workflow not found");
  }
  const status = body.status;
  if (
    !Number.isSafeInteger(body.id) ||
    body.id !== Number(taskIdText) ||
    !isWorkflowStatus(status)
  ) {
    return errorResponse(502, "invalid_gateway_response", "task facade returned invalid workflow state");
  }

  return {
    workflowId: body.id as number,
    status,
    retryCount: Number.isSafeInteger(body.retry_count) ? (body.retry_count as number) : null,
    createdAt: body.created_at ?? null,
    updatedAt: body.updated_at ?? null,
  };
}

async function handleGetWorkflow(
  request: Request,
  workflowIdText: string,
  dependencies: GatewayDependencies,
): Promise<Response> {
  const snapshot = await readWorkflowSnapshot(request, workflowIdText, dependencies);
  if (snapshot instanceof Response) return snapshot;
  return jsonResponse({
    workflow_id: snapshot.workflowId,
    status: snapshot.status,
    retry_count: snapshot.retryCount,
    created_at: snapshot.createdAt,
    updated_at: snapshot.updatedAt,
  });
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function handleCancelWorkflow(
  request: Request,
  workflowIdText: string,
  dependencies: GatewayDependencies,
): Promise<Response> {
  const snapshot = await readWorkflowSnapshot(request, workflowIdText, dependencies);
  if (snapshot instanceof Response) return snapshot;

  if (snapshot.status === "CANCELLED") {
    return jsonResponse({
      workflow_id: snapshot.workflowId,
      status: "CANCELLED",
      replayed: true,
    });
  }
  if (snapshot.status === "COMPLETED" || snapshot.status === "FAILED") {
    return errorResponse(
      409,
      "workflow_not_cancellable",
      `workflow is already terminal with status ${snapshot.status}`,
    );
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  try {
    const upstream = await fetchWithTimeout(
      fetchImpl,
      `${dependencies.config.queueDaemonOrigin}/v1/tasks/${snapshot.workflowId}/cancel`,
      { method: "POST", redirect: "error" },
      dependencies.config.upstreamTimeoutMs,
    );
    if (upstream.status === 404) {
      return errorResponse(404, "workflow_not_found", "workflow not found");
    }
    if (upstream.status === 409) {
      return errorResponse(
        409,
        "workflow_not_cancellable",
        "workflow reached a terminal state before cancellation committed",
      );
    }
    if (upstream.status !== 200) {
      return errorResponse(502, "queue_cancel_failed", "queue daemon rejected workflow cancellation");
    }

    let body: unknown;
    try {
      body = await upstream.json();
    } catch {
      return errorResponse(502, "invalid_queue_response", "queue daemon returned invalid cancellation JSON");
    }
    if (
      !isRecord(body) ||
      body.task_id !== snapshot.workflowId ||
      body.status !== "CANCELLED" ||
      (body.cancellation !== "applied" && body.cancellation !== "replayed")
    ) {
      return errorResponse(502, "invalid_queue_response", "queue daemon returned invalid cancellation state");
    }

    return jsonResponse({
      workflow_id: snapshot.workflowId,
      status: "CANCELLED",
      replayed: body.cancellation === "replayed",
    });
  } catch {
    return errorResponse(503, "queue_unavailable", "queue daemon is unavailable");
  }
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function publicWorkflowProjection(
  workflowId: number,
  wrapper: unknown,
): Record<string, unknown> | null {
  if (
    !isRecord(wrapper) ||
    wrapper.task_id !== workflowId ||
    typeof wrapper.result_json !== "string" ||
    !Number.isSafeInteger(wrapper.result_bytes) ||
    (wrapper.result_bytes as number) < 0 ||
    (wrapper.result_bytes as number) > MAX_WORKFLOW_RESULT_BYTES ||
    encoder.encode(wrapper.result_json).byteLength !== wrapper.result_bytes
  ) {
    return null;
  }

  let projection: unknown;
  try {
    projection = JSON.parse(wrapper.result_json);
  } catch {
    return null;
  }
  if (
    !isRecord(projection) ||
    !exactKeys(projection, ["schema_version", "workflow_task_id", "status", "steps"]) ||
    projection.schema_version !== 1 ||
    projection.workflow_task_id !== workflowId ||
    projection.status !== "COMPLETED" ||
    !Array.isArray(projection.steps) ||
    projection.steps.length === 0 ||
    projection.steps.length > MAX_WORKFLOW_STEPS
  ) {
    return null;
  }

  const steps: Record<string, unknown>[] = [];
  for (const rawStep of projection.steps) {
    if (
      !isRecord(rawStep) ||
      !exactKeys(rawStep, ["id", "type", "task_id", "status"]) ||
      typeof rawStep.id !== "string" ||
      !SAFE_STEP_ID.test(rawStep.id) ||
      typeof rawStep.type !== "string" ||
      !SAFE_TASK_TYPE.test(rawStep.type) ||
      !Number.isSafeInteger(rawStep.task_id) ||
      (rawStep.task_id as number) <= 0 ||
      rawStep.status !== "COMPLETED"
    ) {
      return null;
    }
    steps.push({
      id: rawStep.id,
      type: rawStep.type,
      task_id: rawStep.task_id,
      status: "COMPLETED",
    });
  }

  return {
    schema_version: 1,
    workflow_id: workflowId,
    status: "COMPLETED",
    steps,
  };
}

async function handleGetWorkflowResult(
  request: Request,
  workflowIdText: string,
  dependencies: GatewayDependencies,
): Promise<Response> {
  const snapshot = await readWorkflowSnapshot(request, workflowIdText, dependencies);
  if (snapshot instanceof Response) return snapshot;
  if (snapshot.status !== "COMPLETED") {
    return errorResponse(
      409,
      "workflow_not_completed",
      `workflow result is unavailable while status is ${snapshot.status}`,
    );
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  try {
    const upstream = await fetchWithTimeout(
      fetchImpl,
      `${dependencies.config.queueDaemonOrigin}/v1/tasks/${snapshot.workflowId}/result`,
      { method: "GET", redirect: "error" },
      dependencies.config.upstreamTimeoutMs,
    );
    if (upstream.status === 404) {
      return errorResponse(502, "workflow_result_unavailable", "completed workflow has no result projection");
    }
    if (upstream.status !== 200) {
      return errorResponse(502, "queue_query_failed", "queue daemon could not return workflow result");
    }

    const raw = await upstream.text();
    if (encoder.encode(raw).byteLength > MAX_PUBLIC_REQUEST_BYTES) {
      return errorResponse(502, "invalid_queue_response", "workflow result wrapper exceeds bounded size");
    }
    let wrapper: unknown;
    try {
      wrapper = JSON.parse(raw);
    } catch {
      return errorResponse(502, "invalid_queue_response", "queue daemon returned invalid result JSON");
    }
    const projected = publicWorkflowProjection(snapshot.workflowId, wrapper);
    return projected
      ? jsonResponse(projected)
      : errorResponse(502, "invalid_queue_response", "queue daemon returned invalid workflow projection");
  } catch {
    return errorResponse(503, "queue_unavailable", "queue daemon is unavailable");
  }
}

export async function handlePublicWorkflowRequest(
  request: Request,
  dependencies: GatewayDependencies,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;

  if (path === "/v1/workflows") {
    return request.method === "POST"
      ? handleCreateWorkflow(request, dependencies)
      : errorResponse(405, "method_not_allowed", "POST required");
  }

  const cancelMatch = /^\/v1\/workflows\/([^/]+)\/cancel$/.exec(path);
  if (cancelMatch) {
    return request.method === "POST"
      ? handleCancelWorkflow(request, cancelMatch[1]!, dependencies)
      : errorResponse(405, "method_not_allowed", "POST required");
  }

  const resultMatch = /^\/v1\/workflows\/([^/]+)\/result$/.exec(path);
  if (resultMatch) {
    return request.method === "GET"
      ? handleGetWorkflowResult(request, resultMatch[1]!, dependencies)
      : errorResponse(405, "method_not_allowed", "GET required");
  }

  const workflowMatch = /^\/v1\/workflows\/([^/]+)$/.exec(path);
  if (workflowMatch) {
    return request.method === "GET"
      ? handleGetWorkflow(request, workflowMatch[1]!, dependencies)
      : errorResponse(405, "method_not_allowed", "GET required");
  }

  return null;
}
