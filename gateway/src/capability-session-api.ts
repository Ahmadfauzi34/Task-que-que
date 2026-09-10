import { GATEWAY_VERSION, MAX_PUBLIC_REQUEST_BYTES, type GatewayDependencies } from "./app";
import {
  MAX_CAPABILITY_SESSION_SCOPES,
  MAX_CAPABILITY_SESSION_TTL_SECONDS,
  MIN_CAPABILITY_SESSION_TTL_SECONDS,
  isRootAuthorization,
  issueCapabilitySession,
  validateCapabilityGrant,
} from "./capability-auth";
import {
  CAPABILITY_AUTHORITY,
  CAPABILITY_DEPTH,
  type CapabilityAuthority,
  type CapabilityDepth,
  type CapabilityGrant,
} from "./capabilities";

const encoder = new TextEncoder();
const SESSION_REQUEST_KEYS = new Set(["depth", "authority", "scopes", "ttl_seconds"]);

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

function isDepth(value: unknown): value is CapabilityDepth {
  return Number.isInteger(value) && Object.values(CAPABILITY_DEPTH).includes(value as CapabilityDepth);
}

function isAuthority(value: unknown): value is CapabilityAuthority {
  return Number.isInteger(value) && Object.values(CAPABILITY_AUTHORITY).includes(value as CapabilityAuthority);
}

async function parseSessionRequest(request: Request): Promise<{
  grant: CapabilityGrant;
  ttlSeconds: number;
} | Response> {
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
    return errorResponse(400, "invalid_session_request", "session request must be a JSON object");
  }
  for (const key of Object.keys(parsed)) {
    if (!SESSION_REQUEST_KEYS.has(key)) {
      return errorResponse(400, "unknown_field", `unknown session request field: ${key}`);
    }
  }

  if (!isDepth(parsed.depth)) {
    return errorResponse(400, "invalid_depth", "depth must be an integer capability level D0..D6");
  }
  if (!isAuthority(parsed.authority)) {
    return errorResponse(400, "invalid_authority", "authority must be an integer capability level A0..A4");
  }
  if (!Array.isArray(parsed.scopes) || parsed.scopes.length > MAX_CAPABILITY_SESSION_SCOPES) {
    return errorResponse(
      400,
      "invalid_scopes",
      `scopes must be an array with at most ${MAX_CAPABILITY_SESSION_SCOPES} entries`,
    );
  }
  if (
    !Number.isInteger(parsed.ttl_seconds) ||
    (parsed.ttl_seconds as number) < MIN_CAPABILITY_SESSION_TTL_SECONDS ||
    (parsed.ttl_seconds as number) > MAX_CAPABILITY_SESSION_TTL_SECONDS
  ) {
    return errorResponse(
      400,
      "invalid_ttl",
      `ttl_seconds must be between ${MIN_CAPABILITY_SESSION_TTL_SECONDS} and ${MAX_CAPABILITY_SESSION_TTL_SECONDS}`,
    );
  }

  const grant: CapabilityGrant = {
    depth: parsed.depth,
    authority: parsed.authority,
    scopes: parsed.scopes as string[],
  };
  if (validateCapabilityGrant(grant).length > 0) {
    return errorResponse(400, "invalid_grant", "session grant contains invalid or duplicate scopes");
  }
  return { grant, ttlSeconds: parsed.ttl_seconds as number };
}

export async function handleCapabilitySessionRequest(
  request: Request,
  dependencies: GatewayDependencies,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/capability-sessions") return null;

  if (request.method !== "POST") {
    return errorResponse(405, "method_not_allowed", "POST required");
  }
  if (!isRootAuthorization(request, dependencies.config)) {
    return errorResponse(401, "root_authorization_required", "root bearer token required");
  }
  if (!dependencies.config.apiToken) {
    return errorResponse(503, "session_signing_unavailable", "capability session signing is unavailable");
  }

  const parsed = await parseSessionRequest(request);
  if (parsed instanceof Response) return parsed;

  const issued = await issueCapabilitySession(
    dependencies.config.apiToken,
    parsed.grant,
    parsed.ttlSeconds,
  );
  return jsonResponse(
    {
      schema_version: 1,
      token_type: "Bearer",
      session_token: issued.token,
      session_id: issued.claims.sid,
      issued_at: issued.claims.iat,
      expires_at: issued.claims.exp,
      grant: {
        depth: issued.claims.depth,
        authority: issued.claims.authority,
        scopes: [...issued.claims.scopes],
      },
    },
    201,
  );
}
