import { describe, expect, test } from "bun:test";

import {
  pkceS256Challenge,
  validateOAuthTokenRequest,
  type OAuthAuthorizationCodeBinding,
} from "../src/oauth-token-validation";

const RFC7636_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC7636_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const BINDING: OAuthAuthorizationCodeBinding = Object.freeze({
  code: "opaque-code-123",
  clientId: "claude-public-client",
  redirectUri: "https://claude.example/callback",
  resource: "https://mcp.example.com/mcp",
  codeChallenge: RFC7636_CHALLENGE,
});

function tokenParams(overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code: BINDING.code,
    client_id: BINDING.clientId,
    redirect_uri: BINDING.redirectUri,
    resource: BINDING.resource,
    code_verifier: RFC7636_VERIFIER,
    ...overrides,
  });
}

describe("OAuth token request validation", () => {
  test("matches the RFC 7636 S256 example", async () => {
    expect(await pkceS256Challenge(RFC7636_VERIFIER)).toBe(RFC7636_CHALLENGE);
  });

  test("accepts only a request bound exactly to the authorization code", async () => {
    const result = await validateOAuthTokenRequest(tokenParams(), BINDING);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid token request");
    expect(result.value).toEqual({
      grantType: "authorization_code",
      code: BINDING.code,
      clientId: BINDING.clientId,
      redirectUri: BINDING.redirectUri,
      resource: BINDING.resource,
      codeVerifier: RFC7636_VERIFIER,
    });
  });

  test("rejects duplicate token parameters", async () => {
    for (const parameter of [
      "grant_type",
      "code",
      "client_id",
      "redirect_uri",
      "resource",
      "code_verifier",
    ]) {
      const params = tokenParams();
      params.append(parameter, "attacker-value");
      const result = await validateOAuthTokenRequest(params, BINDING);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected duplicate ${parameter} rejection`);
      expect(result.error).toBe("invalid_request");
    }
  });

  test("rejects wrong grant, client, redirect, code, and resource", async () => {
    const cases = [
      ["grant_type", "client_credentials", "invalid_request"],
      ["client_id", "other-client", "invalid_client"],
      ["redirect_uri", "https://claude.example/callback/", "invalid_grant"],
      ["code", "other-code", "invalid_grant"],
      ["resource", "https://mcp.example.com/mcp/", "invalid_target"],
    ] as const;

    for (const [key, value, expected] of cases) {
      const result = await validateOAuthTokenRequest(
        tokenParams({ [key]: value }),
        BINDING,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected ${key} rejection`);
      expect(result.error).toBe(expected);
    }
  });

  test("rejects malformed or incorrect PKCE verifiers", async () => {
    for (const verifier of [
      "short",
      `${RFC7636_VERIFIER}=`,
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ]) {
      const result = await validateOAuthTokenRequest(
        tokenParams({ code_verifier: verifier }),
        BINDING,
      );
      expect(result.ok).toBe(false);
      if (result.ok) expect(result.error).toBe("invalid_grant");
    }
  });

  test("fails closed when the stored binding itself is malformed", async () => {
    const result = await validateOAuthTokenRequest(tokenParams(), {
      ...BINDING,
      codeChallenge: "not-a-valid-s256-challenge",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_grant");
  });
});
