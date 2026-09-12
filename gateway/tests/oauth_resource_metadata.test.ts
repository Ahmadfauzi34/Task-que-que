import { describe, expect, test } from "bun:test";

import type { GatewayConfig } from "../src/config";
import {
  handleOAuthProtectedResourceMetadataRequest,
  OAUTH_PROTECTED_RESOURCE_MCP,
  OAUTH_PROTECTED_RESOURCE_ROOT,
  oauthProtectedResourceMetadataUrl,
} from "../src/oauth-resource-metadata";

const configured: GatewayConfig = {
  hostname: "127.0.0.1",
  port: 3000,
  queueDaemonOrigin: "http://127.0.0.1:7331",
  workerBrokerOrigin: "http://127.0.0.1:7332",
  publicOrigin: "https://mcp.example.com",
  oauthAuthorizationServer: "https://auth.example.com/tenant",
  apiToken: "test-secret",
  allowUnauthenticated: false,
  upstreamTimeoutMs: 1_000,
  enqueueRatePerSecond: 10,
  enqueueBurst: 20,
  maxActiveTasks: 256,
};

async function body(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("RFC 9728 protected resource metadata", () => {
  test("serves equivalent root and path-aware metadata for the /mcp resource", async () => {
    expect(oauthProtectedResourceMetadataUrl(configured)).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );

    for (const path of [OAUTH_PROTECTED_RESOURCE_ROOT, OAUTH_PROTECTED_RESOURCE_MCP]) {
      const response = handleOAuthProtectedResourceMetadataRequest(
        new Request(`http://gateway.internal${path}`),
        configured,
        "0.2.0",
      );
      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);
      expect(response!.headers.get("cache-control")).toBe("public, max-age=300");
      expect(await body(response!)).toEqual({
        resource: "https://mcp.example.com/mcp",
        authorization_servers: ["https://auth.example.com/tenant"],
        bearer_methods_supported: ["header"],
        resource_name: "Task-que-que MCP",
      });
    }
  });

  test("fails closed when OAuth discovery is not configured", async () => {
    const response = handleOAuthProtectedResourceMetadataRequest(
      new Request(`http://gateway.internal${OAUTH_PROTECTED_RESOURCE_ROOT}`),
      { ...configured, publicOrigin: null, oauthAuthorizationServer: null },
      "0.2.0",
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);
    expect(await body(response!)).toMatchObject({
      error: { code: "oauth_discovery_unavailable" },
    });
  });

  test("allows only GET on the metadata route", async () => {
    const response = handleOAuthProtectedResourceMetadataRequest(
      new Request(`http://gateway.internal${OAUTH_PROTECTED_RESOURCE_MCP}`, {
        method: "POST",
      }),
      configured,
      "0.2.0",
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(405);
    expect(response!.headers.get("allow")).toBe("GET");
  });
});
