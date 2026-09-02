import { describe, expect, test } from "bun:test";

import type { AdmissionController } from "../src/admission";
import type { FetchLike, GatewayDependencies } from "../src/app";
import type { GatewayConfig } from "../src/config";
import { TASK_REGISTRY } from "../src/registry";
import { handlePublicWorkflowRequest } from "../src/workflows";

const config: GatewayConfig = {
  hostname: "127.0.0.1",
  port: 3000,
  queueDaemonOrigin: "http://127.0.0.1:7331",
  apiToken: "workflow-public-secret",
  allowUnauthenticated: false,
  upstreamTimeoutMs: 1_000,
  enqueueRatePerSecond: 10,
  enqueueBurst: 20,
  maxActiveTasks: 256,
};

const admission: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

function deps(fetchImpl: FetchLike): GatewayDependencies {
  return {
    config,
    registry: TASK_REGISTRY,
    admissionController: admission,
    fetchImpl,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, init);
}

function authHeaders(): Headers {
  return new Headers({ authorization: "Bearer workflow-public-secret" });
}

function queueSnapshot(
  id: number,
  status: "PENDING" | "ASSIGNED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED",
  taskName = "workflow.run",
) {
  return {
    id,
    task_name: taskName,
    task_type: taskName === "workflow.run" ? "workflow" : "cpu",
    priority: 0,
    max_retries: 3,
    retry_count: 0,
    status,
    scheduled_at: 1,
    created_at: 1,
    updated_at: 2,
  };
}

describe("public workflow cancellation", () => {
  test("requires bearer authorization before cancellation", async () => {
    let upstreamCalls = 0;
    const fetchImpl: FetchLike = async () => {
      upstreamCalls += 1;
      return new Response();
    };

    const response = await handlePublicWorkflowRequest(
      request("/v1/workflows/7/cancel", { method: "POST" }),
      deps(fetchImpl),
    );

    expect(response?.status).toBe(401);
    expect(upstreamCalls).toBe(0);
  });

  test("revokes an active workflow only after exact workflow identity is proven", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/v1/tasks/8" && (init?.method ?? "GET") === "GET") {
        return Response.json(queueSnapshot(8, "RUNNING"));
      }
      if (path === "/v1/tasks/8/cancel" && init?.method === "POST") {
        return Response.json({ task_id: 8, status: "CANCELLED", already_cancelled: false });
      }
      throw new Error(`unexpected upstream request: ${init?.method ?? "GET"} ${path}`);
    };

    const response = await handlePublicWorkflowRequest(
      request("/v1/workflows/8/cancel", { method: "POST", headers: authHeaders() }),
      deps(fetchImpl),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      workflow_id: 8,
      status: "CANCELLED",
      already_cancelled: false,
    });
    expect(calls).toEqual(["GET /v1/tasks/8", "POST /v1/tasks/8/cancel"]);
  });

  test("does not expose generic task cancellation through the workflow facade", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/v1/tasks/9") {
        return Response.json(queueSnapshot(9, "RUNNING", "hash.compute"));
      }
      throw new Error(`unexpected cancellation call: ${path}`);
    };

    const response = await handlePublicWorkflowRequest(
      request("/v1/workflows/9/cancel", { method: "POST", headers: authHeaders() }),
      deps(fetchImpl),
    );

    expect(response?.status).toBe(404);
    expect(await response?.text()).toContain("workflow_not_found");
    expect(calls).toEqual(["GET /v1/tasks/9"]);
  });

  test("is idempotent once durable workflow state is already CANCELLED", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      return Response.json(queueSnapshot(10, "CANCELLED"));
    };

    const response = await handlePublicWorkflowRequest(
      request("/v1/workflows/10/cancel", { method: "POST", headers: authHeaders() }),
      deps(fetchImpl),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      workflow_id: 10,
      status: "CANCELLED",
      already_cancelled: true,
    });
    expect(calls).toEqual(["GET /v1/tasks/10"]);
  });

  test("never rewrites COMPLETED or FAILED workflow terminals", async () => {
    for (const status of ["COMPLETED", "FAILED"] as const) {
      const calls: string[] = [];
      const fetchImpl: FetchLike = async (input, init) => {
        const path = new URL(String(input)).pathname;
        calls.push(`${init?.method ?? "GET"} ${path}`);
        return Response.json(queueSnapshot(11, status));
      };

      const response = await handlePublicWorkflowRequest(
        request("/v1/workflows/11/cancel", { method: "POST", headers: authHeaders() }),
        deps(fetchImpl),
      );

      expect(response?.status).toBe(409);
      expect(await response?.text()).toContain("workflow_terminal");
      expect(calls).toEqual(["GET /v1/tasks/11"]);
    }
  });

  test("cancelled workflow status is public but its result remains unavailable", async () => {
    let resultReads = 0;
    const fetchImpl: FetchLike = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/tasks/12") return Response.json(queueSnapshot(12, "CANCELLED"));
      if (path.endsWith("/result")) resultReads += 1;
      return new Response(null, { status: 404 });
    };

    const statusResponse = await handlePublicWorkflowRequest(
      request("/v1/workflows/12", { headers: authHeaders() }),
      deps(fetchImpl),
    );
    expect(statusResponse?.status).toBe(200);
    expect((await statusResponse?.json())?.status).toBe("CANCELLED");

    const resultResponse = await handlePublicWorkflowRequest(
      request("/v1/workflows/12/result", { headers: authHeaders() }),
      deps(fetchImpl),
    );
    expect(resultResponse?.status).toBe(409);
    expect(await resultResponse?.text()).toContain("status is CANCELLED");
    expect(resultReads).toBe(0);
  });
});
