import { describe, expect, test } from "bun:test";

import {
  buildOAuthAuthorizationErrorRedirect,
  buildOAuthAuthorizationSuccessRedirect,
} from "../src/oauth-authorization-response";

import type {
  ValidatedOAuthAuthorizationRequest,
} from "../src/oauth-authorization-validation";

const ISSUER = "https://mcp.example.com/oauth";
const CODE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CHALLENGE = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function request(
  overrides: Partial<ValidatedOAuthAuthorizationRequest> = {},
): ValidatedOAuthAuthorizationRequest {
  return {
    responseType: "code",
    clientId: "claude-public-client",
    redirectUri: "https://client.example/callback",
    resource: "https://mcp.example.com/mcp",
    scopes: ["capability.read"],
    state: "opaque-state",
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
    ...overrides,
  };
}

describe("OAuth authorization response builder", () => {
  test("builds success redirect with code, state and exact issuer", () => {
    const result = buildOAuthAuthorizationSuccessRedirect(
      request(),
      ISSUER,
      CODE,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success redirect");

    const url = new URL(result.redirectUri);
    expect(url.origin + url.pathname).toBe("https://client.example/callback");
    expect(url.searchParams.getAll("code")).toEqual([CODE]);
    expect(url.searchParams.getAll("state")).toEqual(["opaque-state"]);
    expect(url.searchParams.getAll("iss")).toEqual([ISSUER]);
    expect(url.searchParams.has("resource")).toBe(false);
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });

  test("preserves the registered redirect URI prefix byte-for-byte", () => {
    const exactRedirect =
      "https://client.example/callback?existing=%2Fvalue%20with%20space&x=1";

    const result = buildOAuthAuthorizationSuccessRedirect(
      request({ redirectUri: exactRedirect }),
      ISSUER,
      CODE,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success redirect");

    expect(
      result.redirectUri.startsWith(
        `${exactRedirect}&code=${CODE}&`,
      ),
    ).toBe(true);
  });

  test("omits state when the authorization request omitted state", () => {
    const result = buildOAuthAuthorizationSuccessRedirect(
      request({ state: null }),
      ISSUER,
      CODE,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success redirect");

    const url = new URL(result.redirectUri);
    expect(url.searchParams.has("state")).toBe(false);
    expect(url.searchParams.get("iss")).toBe(ISSUER);
  });

  test("builds an error redirect without creating code authority", () => {
    const result = buildOAuthAuthorizationErrorRedirect(
      request(),
      ISSUER,
      "access_denied",
      "operator denied consent",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected error redirect");

    const url = new URL(result.redirectUri);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("error_description")).toBe(
      "operator denied consent",
    );
    expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(url.searchParams.get("iss")).toBe(ISSUER);
    expect(url.searchParams.has("code")).toBe(false);
  });

  test("rejects a registered redirect that already contains OAuth response parameters", () => {
    for (const key of [
      "code",
      "error",
      "error_description",
      "error_uri",
      "state",
      "iss",
    ]) {
      const result = buildOAuthAuthorizationSuccessRedirect(
        request({
          redirectUri:
            `https://client.example/callback?${key}=existing`,
        }),
        ISSUER,
        CODE,
      );

      expect(result).toEqual({
        ok: false,
        error: "ambiguous_redirect_uri",
      });
    }
  });

  test("rejects unsafe redirect URIs and issuers", () => {
    for (const redirectUri of [
      "http://client.example/callback",
      "https://user:pass@client.example/callback",
      "https://client.example/callback#fragment",
    ]) {
      expect(
        buildOAuthAuthorizationSuccessRedirect(
          request({ redirectUri }),
          ISSUER,
          CODE,
        ),
      ).toEqual({
        ok: false,
        error: "invalid_redirect_uri",
      });
    }

    for (const issuer of [
      "http://mcp.example.com/oauth",
      "https://user:pass@mcp.example.com/oauth",
      "https://mcp.example.com/oauth?query=1",
      "https://mcp.example.com/oauth#fragment",
    ]) {
      expect(
        buildOAuthAuthorizationSuccessRedirect(
          request(),
          issuer,
          CODE,
        ),
      ).toEqual({
        ok: false,
        error: "invalid_issuer",
      });
    }
  });

  test("rejects malformed authorization codes and error responses", () => {
    for (const code of [
      "",
      "too-short",
      "contains space AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    ]) {
      expect(
        buildOAuthAuthorizationSuccessRedirect(
          request(),
          ISSUER,
          code,
        ),
      ).toEqual({
        ok: false,
        error: "invalid_code",
      });
    }

    expect(
      buildOAuthAuthorizationErrorRedirect(
        request(),
        ISSUER,
        "bad error value",
      ),
    ).toEqual({
      ok: false,
      error: "invalid_error",
    });

    expect(
      buildOAuthAuthorizationErrorRedirect(
        request(),
        ISSUER,
        "access_denied",
        "line one\nline two",
      ),
    ).toEqual({
      ok: false,
      error: "invalid_error",
    });

    expect(
      buildOAuthAuthorizationErrorRedirect(
        request(),
        ISSUER,
        "access_denied",
        "x".repeat(513),
      ),
    ).toEqual({
      ok: false,
      error: "invalid_error",
    });
  });
});
