import { GATEWAY_VERSION } from "./app";
import { isRootAuthorization } from "./capability-auth";
import type { GatewayConfig } from "./config";
import {
  PendingOAuthConsentStore,
  type OAuthConsentDecision,
} from "./oauth-pending-consent-store";

const MAX_DECISION_BODY_BYTES = 4 * 1024;
const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
const DECISION_KEYS = new Set(["decision"]);
const encoder = new TextEncoder();

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

async function parseDecision(request: Request): Promise<OAuthConsentDecision | Response> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return errorResponse(
      415,
      "unsupported_media_type",
      "content-type must be application/json",
    );
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isInteger(length) || length < 0) {
      return errorResponse(400, "invalid_content_length", "invalid content-length");
    }
    if (length > MAX_DECISION_BODY_BYTES) {
      return errorResponse(413, "request_too_large", "decision body exceeds 4 KiB");
    }
  }

  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_DECISION_BODY_BYTES) {
    return errorResponse(413, "request_too_large", "decision body exceeds 4 KiB");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse(400, "invalid_json", "decision body must contain valid JSON");
  }

  if (!isRecord(parsed)) {
    return errorResponse(400, "invalid_decision", "decision body must be a JSON object");
  }

  for (const key of Object.keys(parsed)) {
    if (!DECISION_KEYS.has(key)) {
      return errorResponse(400, "unknown_field", `unknown decision field: ${key}`);
    }
  }

  if (Object.keys(parsed).length !== 1) {
    return errorResponse(400, "invalid_decision", "decision field is required");
  }

  if (parsed.decision !== "approved" && parsed.decision !== "denied") {
    return errorResponse(
      400,
      "invalid_decision",
      "decision must be approved or denied",
    );
  }

  return parsed.decision;
}

function assertNoQuery(url: URL): Response | null {
  return url.search
    ? errorResponse(400, "query_forbidden", "operator consent routes do not accept query parameters")
    : null;
}

export async function handleOAuthConsentOperatorRequest(
  request: Request,
  config: GatewayConfig,
  store: PendingOAuthConsentStore | null | undefined,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  const collection = path === "/v1/oauth/pending-consents";
  const decisionMatch =
    /^\/v1\/oauth\/pending-consents\/([^/]+)\/decision$/.exec(path);

  if (!collection && !decisionMatch) return null;

  const queryError = assertNoQuery(url);
  if (queryError) return queryError;

  if (!isRootAuthorization(request, config)) {
    return errorResponse(
      401,
      "root_authorization_required",
      "root bearer token required",
    );
  }

  if (!store) {
    return errorResponse(
      503,
      "oauth_consent_store_unavailable",
      "OAuth pending consent store is unavailable",
    );
  }

  if (collection) {
    if (request.method !== "GET") {
      return errorResponse(405, "method_not_allowed", "GET required");
    }

    return jsonResponse({
      schema_version: 1,
      pending_consents: store.list(),
    });
  }

  if (request.method !== "POST") {
    return errorResponse(405, "method_not_allowed", "POST required");
  }

  const requestId = decisionMatch![1]!;
  if (!REQUEST_ID.test(requestId)) {
    return errorResponse(
      400,
      "invalid_request_id",
      "pending consent request id is invalid",
    );
  }

  const decision = await parseDecision(request);
  if (decision instanceof Response) return decision;

  const result = store.decide(requestId, decision);
  if (!result.ok) {
    if (result.error === "not_found") {
      return errorResponse(
        404,
        "pending_consent_not_found",
        "pending consent request was not found or has expired",
      );
    }

    return errorResponse(
      409,
      "pending_consent_already_decided",
      "pending consent request has already been decided",
    );
  }

  return jsonResponse({
    schema_version: 1,
    pending_consent: result.value,
  });
}
