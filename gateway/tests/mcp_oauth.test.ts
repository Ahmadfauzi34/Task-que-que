import { describe, expect, test } from "bun:test";

import type { AdmissionController } from "../src/admission";
import type { GatewayDependencies } from "../src/app";
import type { GatewayConfig } from "../src/config";
import {
  handleMcpRequestWithOAuthDiscovery,
  MCP_PROTOCOL_VERSION,
} from "../src/mcp-oauth";
import { TASK_REGISTRY } from "../src/registry";
import { routeGatewayRequest } from "../src/router";

const admissionController: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

function config(oauth: boolean): GatewayConfig {
  return {
    hostname: "127.0.0.1",
    port: 3000,
    queueDaemonOrigin: "http://127.0.0.1:7331",
    workerBrokerOrigin: "http://127.0.0.1:7332",
    ...(oauth
      ? {
          publicOrigin: "https://mcp.example.com",
          oauthAuthorizationServer: "https://auth.example.com/tenant",
        }
      : {}),
    apiToken: "test-secret",
    allowUnauthenticated: false,
    upstreamTimeoutMs: 1_000,
    enqueueRatePerSecond: 10,
    enqueueBurst: 20,
    maxActiveTasks: 256,
  };
}

function dependencies(oauth: boolean): GatewayDependencies {
  return {
    config: config(oauth),
    registry: TASK_REGISTRY,
    admissionController,
    providerFetchImpl: async () => new Response(
      JSON.stringify({ schema_version: 1, active_task_names: [], worker_types: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  } as GatewayDependencies;
}

function unauthenticatedDiscoverRequest(): Request {
  return new Request("http://gateway.internal/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-method": "server/discover",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": {
            name: "oauth-proof-client",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

async function dispatch(oauth: boolean): Promise<Response> {
  const deps = dependencies(oauth);
  const response = await handleMcpRequestWithOAuthDiscovery(
    unauthenticatedDiscoverRequest(),
    deps,
    (inner) => routeGatewayRequest(inner, deps),
  );
  if (!response) throw new Error("MCP request was not handled");
  return response;
}

describe("MCP OAuth resource discovery challenge", () => {
  test("points unauthenticated clients at RFC 9728 metadata when configured", async () => {
    const response = await dispatch(true);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test("preserves the existing Bearer challenge when OAuth discovery is disabled", async () => {
    const response = await dispatch(false);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });
});
