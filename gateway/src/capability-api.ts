import { GATEWAY_VERSION, type GatewayDependencies } from "./app";
import {
  CAPABILITY_AUTHORITY,
  CAPABILITY_DEPTH,
  CAPABILITY_REGISTRY,
  LEGACY_COMPAT_GRANT,
  evaluateCapabilityGrant,
  getCapability,
  projectCapabilityCatalog,
  type CapabilityGrant,
} from "./capabilities";
import type { GatewayConfig } from "./config";

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
  if (config.allowUnauthenticated) return true;
  if (!config.apiToken) return false;

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  return constantTimeEqual(authorization.slice("Bearer ".length), config.apiToken);
}

function namedLevels(record: Readonly<Record<string, number>>) {
  return Object.entries(record)
    .map(([name, level]) => ({ name, level }))
    .sort((left, right) => left.level - right.level);
}

export async function handleCapabilityRequest(
  request: Request,
  dependencies: GatewayDependencies,
  grant: CapabilityGrant = LEGACY_COMPAT_GRANT,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/capabilities") return null;

  if (request.method !== "GET") {
    return errorResponse(405, "method_not_allowed", "GET required");
  }

  if (!isAuthorized(request, dependencies.config)) {
    return errorResponse(401, "unauthorized", "valid bearer token required");
  }

  const discovery = getCapability(CAPABILITY_REGISTRY, "system.capabilities");
  if (!discovery) {
    return errorResponse(500, "capability_registry_invalid", "capability discovery descriptor is missing");
  }

  const decision = evaluateCapabilityGrant(grant, discovery);
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
    grant: {
      depth: grant.depth,
      authority: grant.authority,
      scopes: [...grant.scopes],
    },
    capabilities: projectCapabilityCatalog(CAPABILITY_REGISTRY, grant),
  });
}
