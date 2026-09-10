import { describe, expect, test } from "bun:test";

import type { AdmissionController } from "../src/admission";
import type { GatewayDependencies } from "../src/app";
import { handleCapabilityRequest } from "../src/capability-api";
import {
  CAPABILITY_AUTHORITY,
  CAPABILITY_DEPTH,
  type CapabilityGrant,
} from "../src/capabilities";
import type { GatewayConfig } from "../src/config";
import { TASK_REGISTRY } from "../src/registry";

const config: GatewayConfig = {
  hostname: "127.0.0.1",
  port: 3000,
  queueDaemonOrigin: "http://127.0.0.1:7331",
  apiToken: "test-secret",
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

function request(init: RequestInit = {}): Request {
  return new Request("http://127.0.0.1:3000/v1/capabilities", init);
}

describe("capability discovery api", () => {
  test("is protected by the gateway bearer boundary", async () => {
    const response = await handleCapabilityRequest(request(), dependencies);
    expect(response?.status).toBe(401);
  });

  test("returns the compatibility projection for the existing server token", async () => {
    const response = await handleCapabilityRequest(
      request({ headers: { authorization: "Bearer test-secret" } }),
      dependencies,
    );

    expect(response?.status).toBe(200);
    const body = (await response!.json()) as Record<string, any>;
    expect(body.schema_version).toBe(1);
    expect(body.grant).toEqual({ depth: 6, authority: 4, scopes: ["*"] });

    const discovery = body.capabilities.find(
      (entry: Record<string, unknown>) => entry.name === "system.capabilities",
    );
    expect(discovery).toMatchObject({
      route: "/v1/capabilities",
      method: "GET",
      accessible: true,
    });
  });

  test("projects deeper capabilities as locked for a discovery-only grant", async () => {
    const grant: CapabilityGrant = {
      depth: CAPABILITY_DEPTH.DISCOVER,
      authority: CAPABILITY_AUTHORITY.OBSERVE,
      scopes: ["capability.read"],
    };

    const response = await handleCapabilityRequest(
      request({ headers: { authorization: "Bearer test-secret" } }),
      dependencies,
      grant,
    );

    expect(response?.status).toBe(200);
    const body = (await response!.json()) as Record<string, any>;
    const remoteAgent = body.capabilities.find(
      (entry: Record<string, unknown>) => entry.name === "agent.invoke",
    );
    expect(remoteAgent).toMatchObject({
      accessible: false,
      blocked_by: ["depth", "authority", "scope"],
    });
  });

  test("does not accept client headers as a capability grant", async () => {
    const grant: CapabilityGrant = {
      depth: CAPABILITY_DEPTH.DISCOVER,
      authority: CAPABILITY_AUTHORITY.OBSERVE,
      scopes: [],
    };

    const response = await handleCapabilityRequest(
      request({
        headers: {
          authorization: "Bearer test-secret",
          "x-capability-depth": "6",
          "x-capability-authority": "4",
          "x-capability-scopes": "*",
        },
      }),
      dependencies,
      grant,
    );

    expect(response?.status).toBe(403);
    expect(await response!.text()).toContain("capability_denied");
  });

  test("returns null for non-capability routes", async () => {
    const response = await handleCapabilityRequest(
      new Request("http://127.0.0.1:3000/healthz"),
      dependencies,
    );
    expect(response).toBeNull();
  });
});
