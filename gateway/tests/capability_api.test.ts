import { describe, expect, test } from "bun:test";

import type { AdmissionController } from "../src/admission";
import type { FetchLike, GatewayDependencies } from "../src/app";
import { issueCapabilitySession } from "../src/capability-auth";
import { handleCapabilityRequest } from "../src/capability-api";
import {
  CAPABILITY_AUTHORITY,
  CAPABILITY_DEPTH,
} from "../src/capabilities";
import type { GatewayConfig } from "../src/config";
import { TASK_REGISTRY } from "../src/registry";

const config: GatewayConfig = {
  hostname: "127.0.0.1",
  port: 3000,
  queueDaemonOrigin: "http://127.0.0.1:7331",
  workerBrokerOrigin: "http://127.0.0.1:7332",
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

function withProviders(activeTaskNames: readonly string[]): GatewayDependencies {
  const providerFetchImpl: FetchLike = async () => new Response(
    JSON.stringify({
      schema_version: 1,
      active_task_names: [...activeTaskNames],
      worker_types: [],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  return {
    ...dependencies,
    providerFetchImpl,
  } as GatewayDependencies;
}

function request(token?: string, extraHeaders: HeadersInit = {}): Request {
  const headers = new Headers(extraHeaders);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("http://127.0.0.1:3000/v1/capabilities", { headers });
}

describe("capability discovery api", () => {
  test("is protected by the gateway bearer boundary", async () => {
    const response = await handleCapabilityRequest(request(), dependencies);
    expect(response?.status).toBe(401);
  });

  test("returns the compatibility projection for the existing root token", async () => {
    const response = await handleCapabilityRequest(request("test-secret"), dependencies);

    expect(response?.status).toBe(200);
    const body = (await response!.json()) as Record<string, any>;
    expect(body.schema_version).toBe(1);
    expect(body.subject).toEqual({ kind: "root", session_id: null, expires_at: null });
    expect(body.grant).toEqual({ depth: 6, authority: 4, scopes: ["*"] });

    const discovery = body.capabilities.find(
      (entry: Record<string, unknown>) => entry.name === "system.capabilities",
    );
    expect(discovery).toMatchObject({
      route: "/v1/capabilities",
      method: "GET",
      accessible: true,
      authorized: true,
      available: true,
      executable: true,
    });
  });

  test("separates authorization from live provider availability", async () => {
    const response = await handleCapabilityRequest(
      request("test-secret"),
      withProviders(["document.process", "workflow.run"]),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as Record<string, any>;
    expect(body.runtime.worker_registry_reachable).toBe(true);

    const remoteAgent = body.capabilities.find(
      (entry: Record<string, unknown>) => entry.name === "agent.invoke",
    );
    expect(remoteAgent).toMatchObject({
      accessible: true,
      authorized: true,
      available: false,
      executable: false,
    });

    const document = body.capabilities.find(
      (entry: Record<string, unknown>) => entry.name === "document.process",
    );
    expect(document).toMatchObject({
      accessible: true,
      authorized: true,
      available: true,
      executable: true,
    });
  });

  test("projects deeper capabilities as locked from a signed discovery-only session", async () => {
    const issued = await issueCapabilitySession(
      "test-secret",
      {
        depth: CAPABILITY_DEPTH.DISCOVER,
        authority: CAPABILITY_AUTHORITY.OBSERVE,
        scopes: ["capability.read"],
      },
      300,
    );

    const response = await handleCapabilityRequest(request(issued.token), dependencies);

    expect(response?.status).toBe(200);
    const body = (await response!.json()) as Record<string, any>;
    expect(body.subject.kind).toBe("session");
    expect(body.subject.session_id).toBe(issued.claims.sid);
    expect(body.grant).toEqual({ depth: 0, authority: 0, scopes: ["capability.read"] });
    const remoteAgent = body.capabilities.find(
      (entry: Record<string, unknown>) => entry.name === "agent.invoke",
    );
    expect(remoteAgent).toMatchObject({
      accessible: false,
      authorized: false,
      available: false,
      executable: false,
      blocked_by: ["depth", "authority", "scope"],
    });
  });

  test("does not accept client headers as a capability grant", async () => {
    const issued = await issueCapabilitySession(
      "test-secret",
      {
        depth: CAPABILITY_DEPTH.DISCOVER,
        authority: CAPABILITY_AUTHORITY.OBSERVE,
        scopes: [],
      },
      300,
    );

    const response = await handleCapabilityRequest(
      request(issued.token, {
        "x-capability-depth": "6",
        "x-capability-authority": "4",
        "x-capability-scopes": "*",
      }),
      dependencies,
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
