import {
  GATEWAY_VERSION,
  MAX_PUBLIC_REQUEST_BYTES,
  handleRequest,
  type FetchLike,
  type GatewayDependencies,
} from "./app";

const encoder = new TextEncoder();
const MAX_WORKFLOW_RESULT_BYTES = 256 * 1024;
const MAX_WORKFLOW_OUTPUT_BYTES = 128 * 1024;
const MAX_WORKFLOW_OUTPUTS = 32;
const MAX_WORKFLOW_STEPS = 32;
const SAFE_STEP_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SAFE_TASK_TYPE = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_OUTPUT_NAME = /^[A-Za-z0-9._:-]{1,64}$/;
const FORBIDDEN_OUTPUT_NAMES = new Set(["__proto__", "prototype", "constructor"]);

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-gateway-version": GATEWAY_VERSION,
    },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function taskFacadeRequest(source: Request, path: string): Request {
  const headers = new Headers();
  const authorization = source.headers.get("authorization");
  if (authorization !== null) headers.set("authorization", authorization);
  return new Request(`http://gateway.internal${path}`, { method: "GET", headers });
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

function validateOutputs(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_WORKFLOW_OUTPUTS) return null;
  for (const [name] of entries) {
    if (!SAFE_OUTPUT_NAME.test(name) || FORBIDDEN_OUTPUT_NAMES.has(name)) return null;
  }
  try {
    if (encoder.encode(JSON.stringify(value)).byteLength > MAX_WORKFLOW_OUTPUT_BYTES) return null;
  } catch {
    return null;
  }
  return value;
}

function publicProjection(workflowId: number, wrapper: unknown): Record<string, unknown> | null {
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
    !exactKeys(projection, ["schema_version", "workflow_task_id", "status", "steps", "outputs"]) ||
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

  const outputs = validateOutputs(projection.outputs);
  if (outputs === null) return null;
  return {
    schema_version: 1,
    workflow_id: workflowId,
    status: "COMPLETED",
    steps,
    outputs,
  };
}

async function handleResult(
  request: Request,
  workflowIdText: string,
  dependencies: GatewayDependencies,
): Promise<Response> {
  if (!/^[1-9][0-9]*$/.test(workflowIdText)) {
    return errorResponse(400, "invalid_workflow_id", "workflow id must be a positive integer");
  }

  const delegated = await handleRequest(
    taskFacadeRequest(request, `/v1/tasks/${workflowIdText}`),
    dependencies,
  );
  if (delegated.status === 404) {
    return errorResponse(404, "workflow_not_found", "workflow not found");
  }
  if (delegated.status !== 200) return delegated;

  let snapshot: unknown;
  try {
    snapshot = await delegated.json();
  } catch {
    return errorResponse(502, "invalid_gateway_response", "task facade returned invalid JSON");
  }
  if (
    !isRecord(snapshot) ||
    snapshot.task_name !== "workflow.run" ||
    snapshot.task_type !== "workflow" ||
    snapshot.id !== Number(workflowIdText)
  ) {
    return errorResponse(404, "workflow_not_found", "workflow not found");
  }
  if (snapshot.status !== "COMPLETED") {
    return errorResponse(
      409,
      "workflow_not_completed",
      `workflow result is unavailable while status is ${String(snapshot.status)}`,
    );
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  try {
    const upstream = await fetchWithTimeout(
      fetchImpl,
      `${dependencies.config.queueDaemonOrigin}/v1/tasks/${workflowIdText}/result`,
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
    const projected = publicProjection(Number(workflowIdText), wrapper);
    return projected
      ? jsonResponse(projected)
      : errorResponse(502, "invalid_queue_response", "queue daemon returned invalid workflow projection");
  } catch {
    return errorResponse(503, "queue_unavailable", "queue daemon is unavailable");
  }
}

export async function handleDeclaredWorkflowResultRequest(
  request: Request,
  dependencies: GatewayDependencies,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const match = /^\/v1\/workflows\/([^/]+)\/result$/.exec(path);
  if (!match) return null;
  return request.method === "GET"
    ? handleResult(request, match[1]!, dependencies)
    : errorResponse(405, "method_not_allowed", "GET required");
}
