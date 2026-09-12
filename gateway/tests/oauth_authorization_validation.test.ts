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
      expect(result.redirectAllowed).toBe(false);
    }
  });

  test("never redirects errors for an untrusted client or redirect URI", () => {
    const wrongClient = validateOAuthAuthorizationRequest(
      authorizeUrl({ client_id: "other-client" }),
      POLICY,
    );
    expect(wrongClient.ok).toBe(false);
    if (!wrongClient.ok) {
      expect(wrongClient.error).toBe("unauthorized_client");
      expect(wrongClient.redirectAllowed).toBe(false);
    }

    const wrongRedirect = validateOAuthAuthorizationRequest(
      authorizeUrl({ redirect_uri: "https://claude.example/callback/" }),
      POLICY,
    );
    expect(wrongRedirect.ok).toBe(false);
    if (!wrongRedirect.ok) {
      expect(wrongRedirect.error).toBe("invalid_redirect_uri");
      expect(wrongRedirect.redirectAllowed).toBe(false);
    }
  });

  test("permits redirecting later protocol errors only after client and redirect validation", () => {
    const cases = [
      ["response_type", "token", "unsupported_response_type"],
      ["resource", "https://mcp.example.com/mcp/", "invalid_target"],
      ["scope", "process.command.admin", "invalid_scope"],
      ["code_challenge_method", "plain", "invalid_code_challenge"],
    ] as const;

    for (const [key, value, expectedError] of cases) {
      const result = validateOAuthAuthorizationRequest(
        authorizeUrl({ [key]: value }),
        POLICY,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected ${key} rejection`);
      expect(result.error).toBe(expectedError);
      expect(result.redirectAllowed).toBe(true);
    }
  });

  test("rejects scope escalation and malformed scope sets", () => {
    for (const scope of [
      "capability.read process.command.admin",
      "capability.read capability.read",
      "capability.read  git.read",
      "",
    ]) {
      const result = validateOAuthAuthorizationRequest(authorizeUrl({ scope }), POLICY);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("invalid_scope");
        expect(result.redirectAllowed).toBe(true);
      }
    }
  });

  test("requires PKCE S256 and a canonical SHA-256 challenge shape", () => {
    const plain = validateOAuthAuthorizationRequest(
      authorizeUrl({ code_challenge_method: "plain" }),
      POLICY,
    );
    expect(plain.ok).toBe(false);
    if (!plain.ok) {
      expect(plain.error).toBe("invalid_code_challenge");
      expect(plain.redirectAllowed).toBe(true);
    }

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
      if (!result.ok) {
        expect(result.error).toBe("invalid_code_challenge");
        expect(result.redirectAllowed).toBe(true);
      }
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
    if (!emptyState.ok) {
      expect(emptyState.error).toBe("invalid_request");
      expect(emptyState.redirectAllowed).toBe(true);
    }
  });
});
