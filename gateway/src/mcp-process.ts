import { GATEWAY_VERSION, type GatewayDependencies } from "./app";
import { resolveAuthorizationContext } from "./capability-auth";
import { evaluateCapabilityGrant } from "./capabilities";
import {
  handleMcpRequest,
  MCP_ENDPOINT,
  MCP_PROTOCOL_VERSION,
  type GatewayInvoker,
} from "./mcp";
import {
  loadRegisteredProcessProvider,
  registeredProcessCapabilities,
} from "./process-api";

export { MCP_ENDPOINT, MCP_PROTOCOL_VERSION };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactEmptyArguments(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function processTool(descriptor: ReturnType<typeof registeredProcessCapabilities>[number]) {
  return {
    name: descriptor.name,
    title: descriptor.name,
    description: descriptor.description,
    inputSchema: { type: "object", additionalProperties: false },
    _meta: {
      "com.taskqueque/capability": {
        provider: descriptor.provider,
        min_depth: descriptor.minDepth,
        min_authority: descriptor.minAuthority,
        required_scopes: descriptor.requiredScopes,
        authorized: true,
        available: true,
        executable: true,
        mutates_state: descriptor.mutatesState,
        cancellable: descriptor.cancellable,
        durable: descriptor.durable,
      },
    },
  };
}

function rebuild(base: Response, payload: unknown): Response {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status: base.status,
    headers: new Headers(base.headers),
  });
}

async function processToolsForRequest(
  request: Request,
  dependencies: GatewayDependencies,
) {
  const auth = await resolveAuthorizationContext(request, dependencies.config);
  if (!auth) return [];
  const provider = await loadRegisteredProcessProvider(dependencies);
  if (!provider) return [];

  return registeredProcessCapabilities(provider)
    .filter((descriptor) => evaluateCapabilityGrant(auth.grant, descriptor).allowed)
    .map(processTool);
}

async function processDescriptorForCall(
  request: Request,
  dependencies: GatewayDependencies,
  name: string,
) {
  const auth = await resolveAuthorizationContext(request, dependencies.config);
  if (!auth) return null;
  const provider = await loadRegisteredProcessProvider(dependencies);
  if (!provider) return null;
  const descriptor = registeredProcessCapabilities(provider)
    .find((candidate) => candidate.name === name);
  if (!descriptor) return null;
  return evaluateCapabilityGrant(auth.grant, descriptor).allowed
    ? descriptor
    : null;
}

async function processToolResult(
  id: unknown,
  request: Request,
  descriptor: Awaited<ReturnType<typeof processDescriptorForCall>> & {},
  invokeGateway: GatewayInvoker,
): Promise<Response> {
  const headers = new Headers();
  const authorization = request.headers.get("authorization");
  if (authorization !== null) headers.set("authorization", authorization);

  let response: Response;
  try {
    response = await invokeGateway(new Request(`http://gateway.internal${descriptor.route}`, {
      method: "POST",
      headers,
    }));
  } catch {
    return new Response(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        resultType: "complete",
        content: [{ type: "text", text: "Task-que-que gateway invocation failed." }],
        isError: true,
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "task-que-que",
            version: GATEWAY_VERSION,
          },
        },
      },
    })}\n`, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-gateway-version": GATEWAY_VERSION,
      },
    });
  }

  const raw = await response.text();
  let structured: unknown = null;
  let parseFailed = false;
  try {
    structured = raw.length > 0 ? JSON.parse(raw) : null;
  } catch {
    parseFailed = true;
    structured = {
      error: {
        code: "invalid_gateway_json",
        message: `Gateway returned HTTP ${response.status} with invalid JSON.`,
      },
    };
  }

  const text = JSON.stringify(structured);
  return new Response(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      content: [{ type: "text", text }],
      structuredContent: structured,
      isError: parseFailed || !response.ok,
      _meta: {
        "com.taskqueque/gatewayStatus": response.status,
        "com.taskqueque/gatewayVersion":
          response.headers.get("x-gateway-version") ?? GATEWAY_VERSION,
        "io.modelcontextprotocol/serverInfo": {
          name: "task-que-que",
          version: GATEWAY_VERSION,
        },
      },
    },
  })}\n`, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-gateway-version": GATEWAY_VERSION,
    },
  });
}

export async function handleMcpRequestWithRegisteredProcesses(
  request: Request,
  dependencies: GatewayDependencies,
  invokeGateway: GatewayInvoker,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== MCP_ENDPOINT) return null;

  const mirror = request.clone();
  const base = await handleMcpRequest(request, dependencies, invokeGateway);
  if (!base) return null;

  const method = mirror.headers.get("mcp-method");
  if (method === "tools/list" && base.ok) {
    let payload: unknown;
    try {
      payload = await base.clone().json();
    } catch {
      return base;
    }
    if (!isRecord(payload) || !isRecord(payload.result) || !Array.isArray(payload.result.tools)) {
      return base;
    }

    const extra = await processToolsForRequest(mirror, dependencies);
    if (extra.length === 0) return base;
    const tools = [...payload.result.tools, ...extra]
      .sort((left, right) => String(left?.name ?? "").localeCompare(String(right?.name ?? "")));
    return rebuild(base, {
      ...payload,
      result: { ...payload.result, tools },
    });
  }

  if (method !== "tools/call") return base;

  let basePayload: unknown;
  try {
    basePayload = await base.clone().json();
  } catch {
    return base;
  }
  if (
    !isRecord(basePayload)
    || !isRecord(basePayload.error)
    || basePayload.error.code !== -32602
    || basePayload.error.message !== "unknown or unavailable tool"
  ) {
    return base;
  }

  let rpc: unknown;
  try {
    rpc = await mirror.json();
  } catch {
    return base;
  }
  if (!isRecord(rpc) || !isRecord(rpc.params) || typeof rpc.params.name !== "string") {
    return base;
  }

  const descriptor = await processDescriptorForCall(
    mirror,
    dependencies,
    rpc.params.name,
  );
  if (!descriptor) return base;

  if (!exactEmptyArguments(rpc.params.arguments ?? {})) {
    return rebuild(base, {
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      error: {
        code: -32602,
        message: "tool arguments do not satisfy the advertised input schema",
      },
    });
  }

  return processToolResult(rpc.id ?? null, mirror, descriptor, invokeGateway);
}
