import { GATEWAY_VERSION, type GatewayDependencies } from "./app";
import {
  resolveAuthorizationContext,
  type AuthorizationContext,
} from "./capability-auth";
import {
  CAPABILITY_AUTHORITY,
  CAPABILITY_DEPTH,
  CAPABILITY_REGISTRY,
  evaluateCapabilityGrant,
  getCapability,
  projectCapabilityCatalog,
} from "./capabilities";

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

function namedLevels(record: Readonly<Record<string, number>>) {
  return Object.entries(record)
    .map(([name, level]) => ({ name, level }))
    .sort((left, right) => left.level - right.level);
}

export async function handleCapabilityRequest(
  request: Request,
  dependencies: GatewayDependencies,
  authOverride?: AuthorizationContext,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/capabilities") return null;

  if (request.method !== "GET") {
    return errorResponse(405, "method_not_allowed", "GET required");
  }

  const auth = authOverride ?? await resolveAuthorizationContext(request, dependencies.config);
  if (!auth) {
    return errorResponse(401, "unauthorized", "valid root or capability-session bearer token required");
  }

  const discovery = getCapability(CAPABILITY_REGISTRY, "system.capabilities");
  if (!discovery) {
    return errorResponse(500, "capability_registry_invalid", "capability discovery descriptor is missing");
  }

  const decision = evaluateCapabilityGrant(auth.grant, discovery);
  if (!decision.allowed) {
    return errorResponse(
      403,
      "capability_denied",
      `capability discovery denied by ${decision.blockedBy.join(",") || "policy"}`,
    );
  }

  return jsonResponse({
    schema_version: 1,
    model: {
      depth: namedLevels(CAPABILITY_DEPTH),
      authority: namedLevels(CAPABILITY_AUTHORITY),
    },
    subject: {
      kind: auth.kind,
      session_id: auth.sessionId,
      expires_at: auth.expiresAt,
    },
    grant: {
      depth: auth.grant.depth,
      authority: auth.grant.authority,
      scopes: [...auth.grant.scopes],
    },
    capabilities: projectCapabilityCatalog(CAPABILITY_REGISTRY, auth.grant),
  });
}
