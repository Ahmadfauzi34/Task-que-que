import { describe, expect, test } from "bun:test";

import { loadGatewayConfig } from "../src/config";

const BASE = {
  GATEWAY_API_TOKEN: "test-secret",
};

describe("OAuth resource discovery configuration", () => {
  test("accepts a stable public HTTPS origin and preserves the exact HTTPS issuer identifier", () => {
    const config = loadGatewayConfig({
      ...BASE,
      GATEWAY_PUBLIC_ORIGIN: "https://mcp.example.com",
      GATEWAY_OAUTH_AUTHORIZATION_SERVER: "https://auth.example.com/tenant/",
    });

    expect(config.publicOrigin).toBe("https://mcp.example.com");
    expect(config.oauthAuthorizationServer).toBe("https://auth.example.com/tenant/");
  });

  test("rejects non-HTTPS or non-origin public URLs", () => {
    expect(() => loadGatewayConfig({
      ...BASE,
      GATEWAY_PUBLIC_ORIGIN: "http://mcp.example.com",
    })).toThrow("GATEWAY_PUBLIC_ORIGIN must use HTTPS");

    expect(() => loadGatewayConfig({
      ...BASE,
      GATEWAY_PUBLIC_ORIGIN: "https://mcp.example.com/path",
    })).toThrow("GATEWAY_PUBLIC_ORIGIN must be an origin without path, query, or fragment");
  });

  test("rejects an insecure issuer and issuer configuration without a public origin", () => {
    expect(() => loadGatewayConfig({
      ...BASE,
      GATEWAY_PUBLIC_ORIGIN: "https://mcp.example.com",
      GATEWAY_OAUTH_AUTHORIZATION_SERVER: "http://auth.example.com",
    })).toThrow("GATEWAY_OAUTH_AUTHORIZATION_SERVER must use HTTPS");

    expect(() => loadGatewayConfig({
      ...BASE,
      GATEWAY_OAUTH_AUTHORIZATION_SERVER: "https://auth.example.com",
    })).toThrow(
      "GATEWAY_PUBLIC_ORIGIN is required when GATEWAY_OAUTH_AUTHORIZATION_SERVER is configured",
    );
  });
});
