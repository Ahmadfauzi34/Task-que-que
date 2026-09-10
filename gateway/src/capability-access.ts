import { GATEWAY_VERSION, type GatewayDependencies } from "./app";
import {
  resolveAuthorizationContext,
  type AuthorizationContext,
} from "./capability-auth";
import {
  CAPABILITY_REGISTRY,
  evaluateCapabilityGrant,
  getCapability,
  type CapabilityDescriptor,
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

function requiredSurface(path: string, method: string): string | null {
  if (path === "/v1/tasks" && method === "POST") return "task.submit";
  if (/^\/v1\/tasks\/[^/]+$/.test(path) && method === "GET") return "task.inspect";
  if (path === "/v1/workflows" && method === "POST") return "workflow.submit";
  if (/^\/v1\/workflows\/[^/]+$/.test(path) && method === "GET") return "workflow.inspect";
  if (/^\/v1\/workflows\/[^/]+\/result$/.test(path) && method === "GET") return "workflow.result";
  if (/^\/v1\/workflows\/[^/]+\/cancel$/.test(path) && method === "POST") return "workflow.cancel";
  return null;
}

function authorizeDescriptor(
  auth: AuthorizationContext,
  descriptor: CapabilityDescriptor,
): Response | null {
  const decision = evaluateCapabilityGrant(auth.grant, descriptor);
  return decision.allowed
    ? null
    : errorResponse(
        403,
        "capability_denied",
        `${descriptor.name} denied by ${decision.blockedBy.join(",") || "policy"}`,
      );
}

async function taskDescriptorFromRequest(request: Request): Promise<CapabilityDescriptor | null> {
  let parsed: unknown;
  try {
    parsed = await request.clone().json();
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const type = (parsed as Record<string, unknown>).type;
  if (typeof type !== "string") return null;
  const descriptor = getCapability(CAPABILITY_REGISTRY, type);
  return descriptor?.kind === "task" ? descriptor : null;
}

function internalizeAuthorization(
  request: Request,
  dependencies: GatewayDependencies,
  auth: AuthorizationContext,
): Request {
  if (auth.kind !== "session" || !dependencies.config.apiToken) return request;
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${dependencies.config.apiToken}`);
  return new Request(request, { headers });
}

export async function enforceCapabilityAccess(
  request: Request,
  dependencies: GatewayDependencies,
): Promise<Request | Response> {
  const url = new URL(request.url);
  const surfaceName = requiredSurface(url.pathname, request.method);
  if (!surfaceName) return request;

  const auth = await resolveAuthorizationContext(request, dependencies.config);
  if (!auth) {
    return errorResponse(401, "unauthorized", "valid root or capability-session bearer token required");
  }

  const surface = getCapability(CAPABILITY_REGISTRY, surfaceName);
  if (!surface) {
    return errorResponse(500, "capability_registry_invalid", `${surfaceName} descriptor is missing`);
  }
  const surfaceDenied = authorizeDescriptor(auth, surface);
  if (surfaceDenied) return surfaceDenied;

  if (url.pathname === "/v1/tasks" && request.method === "POST") {
    const taskDescriptor = await taskDescriptorFromRequest(request);
    if (taskDescriptor) {
      const taskDenied = authorizeDescriptor(auth, taskDescriptor);
      if (taskDenied) return taskDenied;
    }
  }

  return internalizeAuthorization(request, dependencies, auth);
}
