import { describe, expect, test } from "bun:test";

import type { AdmissionController } from "../src/admission";
import type { GatewayDependencies } from "../src/app";
import { handleCapabilitySessionRequest } from "../src/capability-session-api";
import { verifyCapabilitySession } from "../src/capability-auth";
import type { GatewayConfig } from "../src/config";
import { TASK_REGISTRY } from "../src/registry";

const config: GatewayConfig = {
  hostname: "127.0.0.1",
  port: 3000,
  queueDaemonOrigin: "http://127.0.0.1:7331",
  apiToken: "root-secret",
  allowUnauthenticated: false,
  upstreamTimeoutMs: 1_000,
  enqueueRatePerSecond: 10,
  enqueueBurst: 20,
  maxActiveTasks: 256,
};

const admissionController: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

const dependencies: GatewayDependencies = {
  config,
  registry: TASK_REGISTRY,
  admissionController,
};

function request(token: string | null, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("http://127.0.0.1:3000/v1/capability-sessions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const validBody = {
  depth: 3,
  authority: 1,
  scopes: ["capability.read", "task.invoke", "task:document.process"],
  ttl_seconds: 300,
};

describe("capability session issuance api", () => {
  test("requires the exact root bearer and does not accept an arbitrary token", async () => {
    const missing = await handleCapabilitySessionRequest(request(null, validBody), dependencies);
    expect(missing?.status).toBe(401);

    const arbitrary = await handleCapabilitySessionRequest(request("not-root", validBody), dependencies);
    expect(arbitrary?.status).toBe(401);
  });

  test("issues a verifiable signed session with the requested attenuated grant", async () => {
    const response = await handleCapabilitySessionRequest(request("root-secret", validBody), dependencies);
    expect(response?.status).toBe(201);
    const body = (await response!.json()) as Record<string, any>;
    expect(body).toMatchObject({
      schema_version: 1,
      token_type: "Bearer",
      grant: {
        depth: 3,
        authority: 1,
        scopes: ["capability.read", "task.invoke", "task:document.process"],
      },
    });
    expect(typeof body.session_token).toBe("string");
    expect(body.session_token.startsWith("tqq1.")).toBe(true);

    const verified = await verifyCapabilitySession(body.session_token, "root-secret");
    expect(verified).toMatchObject({
      kind: "session",
      sessionId: body.session_id,
      grant: body.grant,
    });
  });

  test("fails closed on malformed, oversized, duplicate, or out-of-range grants", async () => {
    const badDepth = await handleCapabilitySessionRequest(
      request("root-secret", { ...validBody, depth: 7 }),
      dependencies,
    );
    expect(badDepth?.status).toBe(400);

    const duplicateScope = await handleCapabilitySessionRequest(
      request("root-secret", { ...validBody, scopes: ["task.read", "task.read"] }),
      dependencies,
    );
    expect(duplicateScope?.status).toBe(400);

    const excessiveTtl = await handleCapabilitySessionRequest(
      request("root-secret", { ...validBody, ttl_seconds: 86_401 }),
      dependencies,
    );
    expect(excessiveTtl?.status).toBe(400);
  });

  test("does not mint signed authority from unauthenticated development mode", async () => {
    const developmentDependencies: GatewayDependencies = {
      ...dependencies,
      config: { ...config, apiToken: null, allowUnauthenticated: true },
    };
    const response = await handleCapabilitySessionRequest(request(null, validBody), developmentDependencies);
    expect(response?.status).toBe(401);
  });
});
