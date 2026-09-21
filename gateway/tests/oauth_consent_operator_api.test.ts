import { describe, expect, test } from "bun:test";

import { loadGatewayConfig } from "../src/config";
import {
  handleOAuthConsentOperatorRequest,
} from "../src/oauth-consent-operator-api";
import {
  PendingOAuthConsentStore,
} from "../src/oauth-pending-consent-store";
import type {
  ValidatedOAuthAuthorizationRequest,
} from "../src/oauth-authorization-validation";

const ROOT = "root-secret";
const CONFIG = loadGatewayConfig({
  GATEWAY_API_TOKEN: ROOT,
});

const REQUEST_ID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CHALLENGE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function validatedRequest(): ValidatedOAuthAuthorizationRequest {
  return {
    responseType: "code",
    clientId: "claude-public-client",
    redirectUri: "https://claude.example/callback",
    resource: "https://mcp.example.com/mcp",
    scopes: ["capability.read"],
    state: "opaque-client-state",
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
  };
}

function store(now = 1_000): PendingOAuthConsentStore {
  return new PendingOAuthConsentStore({
    now: () => now,
    idFactory: () => REQUEST_ID,
  });
}

function request(
  path: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  return new Request(`http://127.0.0.1:3000${path}`, {
    ...init,
    headers,
  });
}

function rootRequest(
  path: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${ROOT}`);
  return request(path, {
    ...init,
    headers,
  });
}

describe("OAuth consent operator API", () => {
  test("ignores unrelated routes", async () => {
    const response = await handleOAuthConsentOperatorRequest(
      request("/healthz"),
      CONFIG,
      store(),
    );
    expect(response).toBeNull();
  });

  test("requires the exact root bearer before parsing operator inputs", async () => {
    const pending = store();
    expect(pending.create(validatedRequest()).ok).toBe(true);

    const noAuth = await handleOAuthConsentOperatorRequest(
      request(
        `/v1/oauth/pending-consents/${REQUEST_ID}/decision?probe=1`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not-json",
        },
      ),
      CONFIG,
      pending,
    );

    expect(noAuth?.status).toBe(401);
    expect(await noAuth?.json()).toEqual({
      error: {
        code: "root_authorization_required",
        message: "root bearer token required",
      },
    });

    const wrongAuth = await handleOAuthConsentOperatorRequest(
      request("/v1/oauth/pending-consents", {
        headers: {
          authorization: "Bearer session-or-other-token",
        },
      }),
      CONFIG,
      pending,
    );

    expect(wrongAuth?.status).toBe(401);
  });

  test("lists only the safe operator projection", async () => {
    const pending = store();
    expect(pending.create(validatedRequest()).ok).toBe(true);

    const response = await handleOAuthConsentOperatorRequest(
      rootRequest("/v1/oauth/pending-consents"),
      CONFIG,
      pending,
    );

    expect(response?.status).toBe(200);
    const body = await response?.json() as {
      pending_consents: Array<Record<string, unknown>>;
    };

    expect(body.pending_consents).toHaveLength(1);
    expect(body.pending_consents[0]?.requestId).toBe(REQUEST_ID);
    expect(body.pending_consents[0]?.status).toBe("pending");
    expect("state" in body.pending_consents[0]!).toBe(false);
    expect("codeChallenge" in body.pending_consents[0]!).toBe(false);
  });

  test("approves or denies exactly once without issuing a code or token", async () => {
    for (const decision of ["approved", "denied"] as const) {
      const pending = store();
      expect(pending.create(validatedRequest()).ok).toBe(true);

      const response = await handleOAuthConsentOperatorRequest(
        rootRequest(
          `/v1/oauth/pending-consents/${REQUEST_ID}/decision`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({ decision }),
          },
        ),
        CONFIG,
        pending,
      );

      expect(response?.status).toBe(200);
      const body = await response?.json() as Record<string, unknown>;
      expect(body.schema_version).toBe(1);
      expect(JSON.stringify(body)).not.toContain("authorization_code");
      expect(JSON.stringify(body)).not.toContain("access_token");

      const replay = await handleOAuthConsentOperatorRequest(
        rootRequest(
          `/v1/oauth/pending-consents/${REQUEST_ID}/decision`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({ decision }),
          },
        ),
        CONFIG,
        pending,
      );

      expect(replay?.status).toBe(409);
    }
  });

  test("rejects query parameters, malformed ids and malformed decision bodies after root auth", async () => {
    const pending = store();
    expect(pending.create(validatedRequest()).ok).toBe(true);

    const query = await handleOAuthConsentOperatorRequest(
      rootRequest("/v1/oauth/pending-consents?unexpected=1"),
      CONFIG,
      pending,
    );
    expect(query?.status).toBe(400);

    const badId = await handleOAuthConsentOperatorRequest(
      rootRequest("/v1/oauth/pending-consents/not-valid!/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      }),
      CONFIG,
      pending,
    );
    expect(badId?.status).toBe(400);

    for (const body of [
      {},
      { decision: "maybe" },
      { decision: "approved", extra: true },
    ]) {
      const response = await handleOAuthConsentOperatorRequest(
        rootRequest(
          `/v1/oauth/pending-consents/${REQUEST_ID}/decision`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        ),
        CONFIG,
        pending,
      );
      expect(response?.status).toBe(400);
    }
  });

  test("fails closed when the store is unavailable or the request is absent", async () => {
    const unavailable = await handleOAuthConsentOperatorRequest(
      rootRequest("/v1/oauth/pending-consents"),
      CONFIG,
      null,
    );
    expect(unavailable?.status).toBe(503);

    const missing = await handleOAuthConsentOperatorRequest(
      rootRequest(
        `/v1/oauth/pending-consents/${REQUEST_ID}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approved" }),
        },
      ),
      CONFIG,
      store(),
    );
    expect(missing?.status).toBe(404);
  });
});
