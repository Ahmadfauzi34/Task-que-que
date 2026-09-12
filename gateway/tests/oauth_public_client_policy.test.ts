import { describe, expect, test } from "bun:test";

import { loadOAuthPublicClientPolicy } from "../src/oauth-public-client-policy";

const ORIGIN = "https://mcp.example.com";
const COMPLETE = {
  GATEWAY_OAUTH_CLIENT_ID: "claude-public-client",
  GATEWAY_OAUTH_REDIRECT_URI: "https://claude.example/api/mcp/auth_callback?source=test",
  GATEWAY_OAUTH_CLIENT_SCOPES: "capability.read git.head",
};

describe("pre-registered OAuth public client policy", () => {
  test("is disabled when no client fields are configured", () => {
    expect(loadOAuthPublicClientPolicy({}, ORIGIN)).toBeNull();
  });

  test("preserves exact client and redirect identifiers and derives the MCP resource", () => {
    expect(loadOAuthPublicClientPolicy(COMPLETE, ORIGIN)).toEqual({
      clientId: "claude-public-client",
      redirectUri: "https://claude.example/api/mcp/auth_callback?source=test",
      resource: "https://mcp.example.com/mcp",
      scopes: ["capability.read", "git.head"],
    });
  });

  test("fails closed when the client tuple is only partially configured", () => {
    for (const partial of [
      { GATEWAY_OAUTH_CLIENT_ID: COMPLETE.GATEWAY_OAUTH_CLIENT_ID },
      { GATEWAY_OAUTH_REDIRECT_URI: COMPLETE.GATEWAY_OAUTH_REDIRECT_URI },
      { GATEWAY_OAUTH_CLIENT_SCOPES: COMPLETE.GATEWAY_OAUTH_CLIENT_SCOPES },
    ]) {
      expect(() => loadOAuthPublicClientPolicy(partial, ORIGIN)).toThrow(
        "must be configured together",
      );
    }
  });

  test("requires a stable HTTPS redirect URI and preserves exact registration identity", () => {
    expect(() => loadOAuthPublicClientPolicy({
      ...COMPLETE,
      GATEWAY_OAUTH_REDIRECT_URI: "http://claude.example/callback",
    }, ORIGIN)).toThrow("must use HTTPS");

    expect(() => loadOAuthPublicClientPolicy({
      ...COMPLETE,
      GATEWAY_OAUTH_REDIRECT_URI: "https://claude.example/callback#fragment",
    }, ORIGIN)).toThrow("must not contain a fragment");

    expect(() => loadOAuthPublicClientPolicy({
      ...COMPLETE,
      GATEWAY_OAUTH_REDIRECT_URI: ` ${COMPLETE.GATEWAY_OAUTH_REDIRECT_URI}`,
    }, ORIGIN)).toThrow("must not contain leading or trailing whitespace");
  });

  test("requires unique capability-mappable scope ceilings", () => {
    for (const scopes of [
      "capability.read capability.read",
      "capability.read  git.head",
      "capability.read scope with spaces",
      "capability.read bad$scope",
    ]) {
      expect(() => loadOAuthPublicClientPolicy({
        ...COMPLETE,
        GATEWAY_OAUTH_CLIENT_SCOPES: scopes,
      }, ORIGIN)).toThrow();
    }
  });

  test("requires the configured public origin before deriving a resource audience", () => {
    expect(() => loadOAuthPublicClientPolicy(COMPLETE, null)).toThrow(
      "GATEWAY_PUBLIC_ORIGIN is required",
    );
    expect(() => loadOAuthPublicClientPolicy(COMPLETE, "http://mcp.example.com")).toThrow(
      "publicOrigin must be an absolute HTTPS origin",
    );
  });
});
