import { describe, expect, test } from "bun:test";

import type { AdmissionController } from "../src/admission";
import type { FetchLike, GatewayDependencies } from "../src/app";
import { issueCapabilitySession } from "../src/capability-auth";
import {
  CAPABILITY_AUTHORITY,
  CAPABILITY_DEPTH,
} from "../src/capabilities";
import type { GatewayConfig } from "../src/config";
import { TASK_REGISTRY } from "../src/registry";
import { routeGatewayRequest } from "../src/router";

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

function dependencies(fetchImpl?: FetchLike): GatewayDependencies {
  return {
    config,
    registry: TASK_REGISTRY,
    admissionController,
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}

function taskRequest(token: string, type = "document.process"): Request {
  return new Request("http://127.0.0.1:3000/v1/tasks", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "session-proof-1",
    },
    body: JSON.stringify({ type, payload: { text: "proof" } }),
  });
}

describe("gateway capability session enforcement", () => {
  test("denies a known task before queue I/O when task-specific scope is missing", async () => {
    let called = false;
    const issued = await issueCapabilitySession(
      "root-secret",
      {
        depth: CAPABILITY_DEPTH.EXECUTE,
        authority: CAPABILITY_AUTHORITY.INVOKE,
        scopes: ["task.invoke"],
      },
      300,
    );

    const response = await routeGatewayRequest(
      taskRequest(issued.token),
      dependencies(async () => {
        called = true;
        return new Response();
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("document.process denied by scope");
    expect(called).toBe(false);
  });

  test("allows an exact task grant and preserves the private Rust task contract", async () => {
    let upstreamHeaders: Headers | null = null;
    const fetchImpl: FetchLike = async (_input, init) => {
      upstreamHeaders = new Headers(init?.headers);
      return Response.json({ task_id: 17, status: "PENDING", idempotency: "created" }, { status: 202 });
    };
    const issued = await issueCapabilitySession(
      "root-secret",
      {
        depth: CAPABILITY_DEPTH.EXECUTE,
        authority: CAPABILITY_AUTHORITY.INVOKE,
        scopes: ["task.invoke", "task:document.process"],
      },
      300,
    );

    const response = await routeGatewayRequest(taskRequest(issued.token), dependencies(fetchImpl));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ task_id: 17, status: "PENDING" });
    expect(upstreamHeaders?.get("x-task-name")).toBe("document.process");
    expect(upstreamHeaders?.get("x-task-type")).toBe("cpu");
    expect(upstreamHeaders?.has("authorization")).toBe(false);
  });

  test("keeps workflow facade authority separate from its internal workflow.run executor", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return Response.json({ task_id: 29, status: "PENDING", idempotency: "created" }, { status: 202 });
    };
    const issued = await issueCapabilitySession(
      "root-secret",
      {
        depth: CAPABILITY_DEPTH.ORCHESTRATE,
        authority: CAPABILITY_AUTHORITY.COMPOSE,
        scopes: ["workflow.compose"],
      },
      300,
    );

    const response = await routeGatewayRequest(
      new Request("http://127.0.0.1:3000/v1/workflows", {
        method: "POST",
        headers: {
          authorization: `Bearer ${issued.token}`,
          "content-type": "application/json",
          "idempotency-key": "workflow-session-proof-1",
        },
        body: JSON.stringify({ steps: [{ id: "one", type: "document.process", payload: {} }] }),
      }),
      dependencies(fetchImpl),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ workflow_id: 29, status: "PENDING" });
    expect(calls).toBe(1);
  });

  test("root token keeps legacy full-authority behavior", async () => {
    const fetchImpl: FetchLike = async () =>
      Response.json({ task_id: 33, status: "PENDING", idempotency: "created" }, { status: 202 });

    const response = await routeGatewayRequest(taskRequest("root-secret", "hash.compute"), dependencies(fetchImpl));
    expect(response.status).toBe(202);
  });
});
