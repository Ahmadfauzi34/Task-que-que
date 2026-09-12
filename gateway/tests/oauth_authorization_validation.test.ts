import { describe, expect, test } from "bun:test";

import {
  validateOAuthAuthorizationRequest,
  type OAuthPublicClientPolicy,
} from "../src/oauth-authorization-validation";

const POLICY: OAuthPublicClientPolicy = Object.freeze({
  clientId: "claude-public-client",
  redirectUri: "https://claude.example/callback",
  resource: "https://mcp.example.com/mcp",
  scopes: Object.freeze(["capability.read", "git.read"]),
});

const CHALLENGE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function authorizeUrl(overrides: Record<string, string> = {}): URL {
  const values: Record<string, string> = {
    response_type: "code",
    client_id: POLICY.clientId,
    redirect_uri: POLICY.redirectUri,
    resource: POLICY.resource,
    scope: "capability.read",
    state: "state-123",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    ...overrides,
  };
  const url = new URL("https://auth.example.com/oauth/authorize");
  for (const [key, value] of Object.entries(values)) {
    url.searchParams.set(key, value);
  }
  return url;
}

describe("OAuth authorization request validation", () => {
  test("accepts the exact pre-registered public client and narrows scopes", () => {
    const result = validateOAuthAuthorizationRequest(
      authorizeUrl({ scope: "capability.read git.read" }),
      POLICY,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid authorization request");
    expect(result.value).toEqual({
      responseType: "code",
      clientId: POLICY.clientId,
      redirectUri: POLICY.redirectUri,
      resource: POLICY.resource,
      scopes: ["capability.read", "git.read"],
      state: "state-123",
      codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256",
    });
  });

  test("rejects duplicate security-sensitive parameters before redirect authority exists", () => {
    for (const parameter of [
      "response_type",
      "client_id",
      "redirect_uri",
      "resource",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
    ]) {
      const url = authorizeUrl();
      url.searchParams.append(parameter, "attacker-value");
      const result = validateOAuthAuthorizationRequest(url, POLICY);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected duplicate ${parameter} rejection`);
      expect(result.error).toBe("invalid_request");
    }
  });

  test("rejects wrong client, redirect URI, and resource exactly", () => {
    const cases = [
      ["client_id", "other-client", "unauthorized_client"],
      ["redirect_uri", "https://claude.example/callback/", "invalid_redirect_uri"],
      ["resource", "https://mcp.example.com/mcp/", "invalid_target"],
    ] as const;

    for (const [key, value, expectedError] of cases) {
      const result = validateOAuthAuthorizationRequest(
        authorizeUrl({ [key]: value }),
        POLICY,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected ${key} rejection`);
      expect(result.error).toBe(expectedError);
    }
  });

  test("rejects unsupported response types and scope escalation", () => {
    const implicit = validateOAuthAuthorizationRequest(
      authorizeUrl({ response_type: "token" }),
      POLICY,
    );
    expect(implicit.ok).toBe(false);
    if (!implicit.ok) expect(implicit.error).toBe("unsupported_response_type");

    for (const scope of [
      "capability.read process.command.admin",
      "capability.read capability.read",
      "capability.read  git.read",
      "",
    ]) {
      const result = validateOAuthAuthorizationRequest(authorizeUrl({ scope }), POLICY);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("invalid_scope");
    }
  });

  test("requires PKCE S256 and a canonical SHA-256 challenge shape", () => {
    const plain = validateOAuthAuthorizationRequest(
      authorizeUrl({ code_challenge_method: "plain" }),
      POLICY,
    );
    expect(plain.ok).toBe(false);
    if (!plain.ok) expect(plain.error).toBe("invalid_code_challenge");

    for (const challenge of [
      "short",
      `${CHALLENGE}=`,
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    ]) {
      const result = validateOAuthAuthorizationRequest(
        authorizeUrl({ code_challenge: challenge }),
        POLICY,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("invalid_code_challenge");
    }
  });

  test("allows omitted state but rejects an explicitly empty state", () => {
    const withoutState = authorizeUrl();
    withoutState.searchParams.delete("state");
    const accepted = validateOAuthAuthorizationRequest(withoutState, POLICY);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.value.state).toBeNull();

    const emptyState = validateOAuthAuthorizationRequest(
      authorizeUrl({ state: "" }),
      POLICY,
    );
    expect(emptyState.ok).toBe(false);
    if (!emptyState.ok) expect(emptyState.error).toBe("invalid_request");
  });
});
