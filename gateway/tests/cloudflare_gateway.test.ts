import { describe, expect, test } from "bun:test";

import type { AdmissionController } from "../src/admission";
import type { CloudflareAccessVerifierLike } from "../src/cloudflare_access";
import { handleRequest, type FetchLike } from "../src/app";
import { loadGatewayConfig, type GatewayConfig } from "../src/config";
import { TASK_REGISTRY } from "../src/registry";

const allowAllAdmission: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

const config: GatewayConfig = {
  hostname: "127.0.0.1",
  port: 3000,
  queueDaemonOrigin: "http://127.0.0.1:7331",
  authMode: "cloudflare_access_service",
  apiToken: null,
  allowUnauthenticated: false,
  cloudflareAccessTeamDomain: "https://reference-team.cloudflareaccess.com",
  cloudflareAccessAudience:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  cloudflareAccessServiceTokenClientId: "reference-service.access",
  upstreamTimeoutMs: 1_000,
  enqueueRatePerSecond: 10,
  enqueueBurst: 20,
};

const validVerifier: CloudflareAccessVerifierLike = {
  verify: async () => ({
    ok: true,
    principal: {
      kind: "service",
      scope: "cloudflare-service:reference-service.access",
    },
  }),
};

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, init);
}

function cloudflareHeaders(idempotencyKey = "external-retry-key"): HeadersInit {
  return {
    "cf-access-jwt-assertion": "signed-cloudflare-assertion",
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };
}

function dependencies(
  verifier: CloudflareAccessVerifierLike,
  fetchImpl?: FetchLike,
) {
  return {
    config,
    registry: TASK_REGISTRY,
    admissionController: allowAllAdmission,
    cloudflareAccessVerifier: verifier,
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}

describe("Cloudflare Access gateway configuration", () => {
  test("loads service auth without a legacy bearer secret", () => {
    const loaded = loadGatewayConfig({
      GATEWAY_AUTH_MODE: "cloudflare_access_service",
      GATEWAY_CF_ACCESS_TEAM_DOMAIN: "https://reference-team.cloudflareaccess.com",
      GATEWAY_CF_ACCESS_AUD:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      GATEWAY_CF_ACCESS_SERVICE_TOKEN_CLIENT_ID: "reference-service.access",
    });

    expect(loaded.authMode).toBe("cloudflare_access_service");
    expect(loaded.apiToken).toBeNull();
    expect(loaded.cloudflareAccessTeamDomain).toBe(
      "https://reference-team.cloudflareaccess.com",
    );
  });

  test("fails closed on incomplete or ambiguous Cloudflare configuration", () => {
    expect(() =>
      loadGatewayConfig({ GATEWAY_AUTH_MODE: "cloudflare_access_service" }),
    ).toThrow("requires GATEWAY_CF_ACCESS_TEAM_DOMAIN");

    expect(() =>
      loadGatewayConfig({
        GATEWAY_AUTH_MODE: "cloudflare_access_service",
        GATEWAY_ALLOW_UNAUTHENTICATED: "1",
        GATEWAY_CF_ACCESS_TEAM_DOMAIN: "https://reference-team.cloudflareaccess.com",
        GATEWAY_CF_ACCESS_AUD: "audience",
        GATEWAY_CF_ACCESS_SERVICE_TOKEN_CLIENT_ID: "reference-service.access",
      }),
    ).toThrow("incompatible");

    expect(() =>
      loadGatewayConfig({
        GATEWAY_AUTH_MODE: "cloudflare_access_service",
        GATEWAY_CF_ACCESS_TEAM_DOMAIN: "https://example.com",
        GATEWAY_CF_ACCESS_AUD: "audience",
        GATEWAY_CF_ACCESS_SERVICE_TOKEN_CLIENT_ID: "reference-service.access",
      }),
    ).toThrow("cloudflareaccess.com");
  });
});

describe("Cloudflare Access gateway provenance", () => {
  test("missing or invalid assertions fail before Rust", async () => {
    let rustCalls = 0;
    const fetchImpl: FetchLike = async () => {
      rustCalls += 1;
      return new Response();
    };

    const missing = await handleRequest(
      request("/v1/tasks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "missing-cf",
        },
        body: JSON.stringify({ type: "document.process", payload: { id: 1 } }),
      }),
      dependencies(validVerifier, fetchImpl),
    );
    expect(missing.status).toBe(401);
    expect(await missing.text()).toContain("cloudflare_access_required");

    const invalidVerifier: CloudflareAccessVerifierLike = {
      verify: async () => ({ ok: false, reason: "invalid" }),
    };
    const invalid = await handleRequest(
      request("/v1/tasks", {
        method: "POST",
        headers: cloudflareHeaders("invalid-cf"),
        body: JSON.stringify({ type: "document.process", payload: { id: 1 } }),
      }),
      dependencies(invalidVerifier, fetchImpl),
    );
    expect(invalid.status).toBe(401);
    expect(await invalid.text()).toContain("invalid_cloudflare_access_assertion");
    expect(rustCalls).toBe(0);
  });

  test("JWKS outage fails closed instead of falling back to caller headers", async () => {
    const unavailableVerifier: CloudflareAccessVerifierLike = {
      verify: async () => ({ ok: false, reason: "unavailable" }),
    };

    const response = await handleRequest(
      request("/v1/tasks", {
        method: "POST",
        headers: cloudflareHeaders("jwks-offline"),
        body: JSON.stringify({ type: "document.process", payload: { id: 1 } }),
      }),
      dependencies(unavailableVerifier),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("identity_provider_unavailable");
  });

  test("verified service principal scopes the private idempotency namespace", async () => {
    let capturedHeaders = new Headers();
    const fetchImpl: FetchLike = async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return Response.json(
        { task_id: 11, status: "PENDING", idempotency: "created" },
        { status: 202 },
      );
    };

    const response = await handleRequest(
      request("/v1/tasks", {
        method: "POST",
        headers: cloudflareHeaders("client-visible-key"),
        body: JSON.stringify({
          type: "document.process",
          payload: { document_id: "cf-proof" },
          priority: 10,
          max_retries: 3,
        }),
      }),
      dependencies(validVerifier, fetchImpl),
    );

    expect(response.status).toBe(202);
    expect(capturedHeaders.get("x-idempotency-key")).toMatch(/^cf:[0-9a-f]{64}$/);
    expect(capturedHeaders.get("x-idempotency-key")).not.toContain("client-visible-key");
    expect(capturedHeaders.get("x-idempotency-key")).not.toContain("reference-service.access");
    expect(capturedHeaders.get("x-request-fingerprint")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("task query also requires the verified Cloudflare service boundary", async () => {
    let rustCalls = 0;
    const fetchImpl: FetchLike = async () => {
      rustCalls += 1;
      return Response.json({
        id: 11,
        task_name: "document.process",
        task_type: "cpu",
        priority: 10,
        max_retries: 3,
        retry_count: 0,
        status: "PENDING",
        locked_by: null,
        locked_until: null,
        heartbeat_at: null,
        error_log: null,
        scheduled_at: 1,
        created_at: 1,
        updated_at: 1,
        lease_generation: 0,
      });
    };

    const missing = await handleRequest(
      request("/v1/tasks/11"),
      dependencies(validVerifier, fetchImpl),
    );
    expect(missing.status).toBe(401);
    expect(rustCalls).toBe(0);

    const accepted = await handleRequest(
      request("/v1/tasks/11", {
        headers: { "cf-access-jwt-assertion": "signed-cloudflare-assertion" },
      }),
      dependencies(validVerifier, fetchImpl),
    );
    expect(accepted.status).toBe(200);
    expect(rustCalls).toBe(1);
  });
});
