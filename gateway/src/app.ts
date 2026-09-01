import type { AdmissionController } from "./admission";
import type { GatewayConfig } from "./config";
import { getTaskPolicy, type TaskRegistry } from "./registry";

export const GATEWAY_VERSION = "0.2.0";
export const MAX_PUBLIC_REQUEST_BYTES = 1024 * 1024;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GatewayDependencies {
  config: GatewayConfig;
  registry: TaskRegistry;
  admissionController: AdmissionController;
  fetchImpl?: FetchLike;
}

interface PublicTaskRequest {
  type: string;
  payload: unknown;
  priority?: number;
  max_retries?: number;
}

const TASK_REQUEST_KEYS = new Set(["type", "payload", "priority", "max_retries"]);
const encoder = new TextEncoder();

function jsonResponse(value: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-gateway-version", GATEWAY_VERSION);

  return new Response(`${JSON.stringify(value)}\n`, { status, headers });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extraHeaders?: HeadersInit,
): Response {
  return jsonResponse({ error: { code, message } }, status, extraHeaders);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }

  return diff === 0;
}

function isAuthorized(request: Request, config: GatewayConfig): boolean {
  if (config.allowUnauthenticated) {
    return true;
  }

  if (!config.apiToken) {
    return false;
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }

  return constantTimeEqual(authorization.slice("Bearer ".length), config.apiToken);
}

function requireAuthorization(request: Request, config: GatewayConfig): Response | null {
  return isAuthorized(request, config)
    ? null
    : errorResponse(401, "unauthorized", "valid bearer token required");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parsePublicTaskRequest(request: Request): Promise<PublicTaskRequest | Response> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return errorResponse(415, "unsupported_media_type", "content-type must be application/json");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const parsedLength = Number(declaredLength);
    if (!Number.isInteger(parsedLength) || parsedLength < 0) {
      return errorResponse(400, "invalid_content_length", "invalid content-length");
    }
    if (parsedLength > MAX_PUBLIC_REQUEST_BYTES) {
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

  if (!isPlainObject(parsed)) {
    return errorResponse(400, "invalid_request", "request body must be a JSON object");
  }

  for (const key of Object.keys(parsed)) {
    if (!TASK_REQUEST_KEYS.has(key)) {
      return errorResponse(400, "unknown_field", `unknown request field: ${key}`);
    }
  }

  if (typeof parsed.type !== "string" || parsed.type.length === 0 || parsed.type.length > 128) {
    return errorResponse(400, "invalid_task_type", "type must be a non-empty string up to 128 bytes");
  }
  if (!("payload" in parsed)) {
    return errorResponse(400, "missing_payload", "payload is required");
  }
  if (parsed.priority !== undefined && !Number.isInteger(parsed.priority)) {
    return errorResponse(400, "invalid_priority", "priority must be an integer");
  }
  if (parsed.max_retries !== undefined && !Number.isInteger(parsed.max_retries)) {
    return errorResponse(400, "invalid_max_retries", "max_retries must be an integer");
  }

  return parsed as unknown as PublicTaskRequest;
}

function parseIdempotencyKey(request: Request): string | Response {
  const value = request.headers.get("idempotency-key");
  if (!value) {
    return errorResponse(
      400,
      "missing_idempotency_key",
      "Idempotency-Key header is required for task creation",
    );
  }

  if (value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    return errorResponse(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must be 1..128 ASCII characters using A-Z a-z 0-9 . _ : -",
    );
  }

  return value;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }

  throw new Error("request contains a non-JSON value");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requestFingerprint(
  taskType: string,
  queueKind: string,
  priority: number,
  maxRetries: number,
  payload: unknown,
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      contract_version: 1,
      type: taskType,
      queue_kind: queueKind,
      priority,
      max_retries: maxRetries,
      payload,
    }),
  );
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

function upstreamUrl(config: GatewayConfig, path: string): string {
  return `${config.queueDaemonOrigin}${path}`;
}

async function handleReady(
  config: GatewayConfig,
  fetchImpl: FetchLike,
): Promise<Response> {
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      upstreamUrl(config, "/readyz"),
      { method: "GET" },
      config.upstreamTimeoutMs,
    );

    if (response.status !== 200) {
      return errorResponse(503, "queue_not_ready", "queue daemon is not ready");
    }

    return jsonResponse({ status: "ready", queue: "ready" });
  } catch {
    return errorResponse(503, "queue_unavailable", "queue daemon is unavailable");
  }
}

async function handleCreateTask(
  request: Request,
  config: GatewayConfig,
  registry: TaskRegistry,
  admissionController: AdmissionController,
  fetchImpl: FetchLike,
): Promise<Response> {
  const denied = requireAuthorization(request, config);
  if (denied) {
    return denied;
  }

  const idempotencyKey = parseIdempotencyKey(request);
  if (idempotencyKey instanceof Response) {
    return idempotencyKey;
  }

  const parsed = await parsePublicTaskRequest(request);
  if (parsed instanceof Response) {
    return parsed;
  }

  const policy = getTaskPolicy(registry, parsed.type);
  if (!policy) {
    return errorResponse(422, "unregistered_task_type", "task type is not registered");
  }

  const priority = parsed.priority ?? 0;
  if (priority < policy.minPriority || priority > policy.maxPriority) {
    return errorResponse(
      422,
      "priority_out_of_policy",
      `priority must be between ${policy.minPriority} and ${policy.maxPriority}`,
    );
  }

  const maxRetries = parsed.max_retries ?? Math.min(3, policy.maxRetries);
  if (maxRetries < 0 || maxRetries > policy.maxRetries) {
    return errorResponse(
      422,
      "max_retries_out_of_policy",
      `max_retries must be between 0 and ${policy.maxRetries}`,
    );
  }

  const payload = JSON.stringify(parsed.payload);
  const payloadBytes = encoder.encode(payload).byteLength;
  if (payloadBytes > policy.maxPayloadBytes) {
    return errorResponse(
      413,
      "payload_too_large",
      `serialized payload exceeds ${policy.maxPayloadBytes} bytes for this task type`,
    );
  }

  const admission = admissionController.tryAcquire();
  if (!admission.allowed) {
    return errorResponse(
      429,
      "rate_limited",
      "task admission rate exceeded; retry later with the same Idempotency-Key",
      { "retry-after": String(admission.retryAfterSeconds) },
    );
  }

  let fingerprint: string;
  try {
    fingerprint = await requestFingerprint(
      parsed.type,
      policy.queueKind,
      priority,
      maxRetries,
      parsed.payload,
    );
  } catch {
    return errorResponse(400, "invalid_payload", "payload must contain only valid JSON values");
  }

  try {
    const upstream = await fetchWithTimeout(
      fetchImpl,
      upstreamUrl(config, "/v1/tasks"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-task-name": parsed.type,
          "x-task-type": policy.queueKind,
          "x-task-priority": String(priority),
          "x-task-max-retries": String(maxRetries),
          "x-idempotency-key": idempotencyKey,
          "x-request-fingerprint": fingerprint,
        },
        body: payload,
      },
      config.upstreamTimeoutMs,
    );

    if (upstream.status === 409) {
      return errorResponse(
        409,
        "idempotency_conflict",
        "Idempotency-Key was already used for a different task request",
      );
    }
    if (upstream.status !== 202) {
      return errorResponse(502, "queue_rejected_task", "queue daemon rejected the task");
    }

    const body = (await upstream.json()) as Record<string, unknown>;
    const idempotency = body.idempotency;
    if (
      !Number.isInteger(body.task_id) ||
      (body.task_id as number) <= 0 ||
      body.status !== "PENDING" ||
      (idempotency !== "created" && idempotency !== "replayed")
    ) {
      return errorResponse(502, "invalid_queue_response", "queue daemon returned an invalid response");
    }

    const replayed = idempotency === "replayed";
    return jsonResponse(
      { task_id: body.task_id, status: "PENDING", replayed },
      202,
      replayed ? { "idempotency-replayed": "true" } : undefined,
    );
  } catch {
    return errorResponse(503, "queue_unavailable", "queue daemon is unavailable");
  }
}

function publicTaskSnapshot(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value) || !Number.isInteger(value.id) || (value.id as number) <= 0) {
    return null;
  }

  const allowed = [
    "id",
    "task_name",
    "task_type",
    "priority",
    "max_retries",
    "retry_count",
    "status",
    "locked_by",
    "locked_until",
    "heartbeat_at",
    "error_log",
    "scheduled_at",
    "created_at",
    "updated_at",
    "lease_generation",
  ] as const;

  const snapshot: Record<string, unknown> = {};
  for (const key of allowed) {
    snapshot[key] = value[key] ?? null;
  }
  return snapshot;
}

async function handleGetTask(
  request: Request,
  taskIdText: string,
  config: GatewayConfig,
  fetchImpl: FetchLike,
): Promise<Response> {
  const denied = requireAuthorization(request, config);
  if (denied) {
    return denied;
  }

  if (!/^[1-9][0-9]*$/.test(taskIdText)) {
    return errorResponse(400, "invalid_task_id", "task id must be a positive integer");
  }

  try {
    const upstream = await fetchWithTimeout(
      fetchImpl,
      upstreamUrl(config, `/v1/tasks/${taskIdText}`),
      { method: "GET" },
      config.upstreamTimeoutMs,
    );

    if (upstream.status === 404) {
      return errorResponse(404, "task_not_found", "task not found");
    }
    if (upstream.status !== 200) {
      return errorResponse(502, "queue_query_failed", "queue daemon could not return task state");
    }

    const snapshot = publicTaskSnapshot(await upstream.json());
    return snapshot
      ? jsonResponse(snapshot)
      : errorResponse(502, "invalid_queue_response", "queue daemon returned an invalid task snapshot");
  } catch {
    return errorResponse(503, "queue_unavailable", "queue daemon is unavailable");
  }
}

export async function handleRequest(
  request: Request,
  dependencies: GatewayDependencies,
): Promise<Response> {
  const { config, registry, admissionController, fetchImpl = fetch } = dependencies;
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/healthz") {
    return request.method === "GET"
      ? jsonResponse({ status: "ok", version: GATEWAY_VERSION })
      : errorResponse(405, "method_not_allowed", "GET required");
  }

  if (path === "/readyz") {
    return request.method === "GET"
      ? handleReady(config, fetchImpl)
      : errorResponse(405, "method_not_allowed", "GET required");
  }

  if (path === "/v1/tasks") {
    return request.method === "POST"
      ? handleCreateTask(request, config, registry, admissionController, fetchImpl)
      : errorResponse(405, "method_not_allowed", "POST required");
  }

  const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(path);
  if (taskMatch) {
    return request.method === "GET"
      ? handleGetTask(request, taskMatch[1]!, config, fetchImpl)
      : errorResponse(405, "method_not_allowed", "GET required");
  }

  return errorResponse(404, "not_found", "route not found");
}
