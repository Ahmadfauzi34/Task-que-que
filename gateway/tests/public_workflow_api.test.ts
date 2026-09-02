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

function authHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("authorization", "Bearer workflow-public-secret");
  return headers;
}

function queueSnapshot(id: number, taskName = "workflow.run", status = "COMPLETED") {
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

describe("public workflow creation", () => {
  test("delegates to the existing workflow.run task admission path", async () => {
    let sawQueueCreate = false;
    const workflow = {
      steps: [{ id: "hash", type: "hash.compute", payload: { data: "x", algorithm: "sha256" } }],
    };
    const fetchImpl: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname !== "/v1/tasks" || init?.method !== "POST") {
        throw new Error(`unexpected upstream request: ${url.pathname}`);
      }
      sawQueueCreate = true;
      const headers = new Headers(init.headers);
      expect(headers.get("x-task-name")).toBe("workflow.run");
      expect(headers.get("x-task-type")).toBe("workflow");
      expect(headers.get("x-idempotency-key")).toBe("external-agent-workflow-1");
      expect(JSON.parse(String(init.body))).toEqual(workflow);
      return Response.json({ task_id: 41, status: "PENDING", idempotency: "created" }, { status: 202 });
    };

    const response = await handlePublicWorkflowRequest(
      request("/v1/workflows", {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": "external-agent-workflow-1",
        }),
        body: JSON.stringify(workflow),
      }),
      deps(fetchImpl),
    );

    expect(sawQueueCreate).toBe(true);
    expect(response?.status).toBe(202);
    expect(response?.headers.get("location")).toBe("/v1/workflows/41");
    expect(await response?.json()).toEqual({ workflow_id: 41, status: "PENDING", replayed: false });
  });

  test("inherits bearer auth and idempotency requirements", async () => {
    let upstreamCalls = 0;
    const fetchImpl: FetchLike = async () => {
      upstreamCalls += 1;
      return new Response();
    };
    const body = JSON.stringify({ steps: [] });

    const unauthorized = await handlePublicWorkflowRequest(
      request("/v1/workflows", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "wf-1" },
        body,
      }),
      deps(fetchImpl),
    );
    expect(unauthorized?.status).toBe(401);

    const missingKey = await handlePublicWorkflowRequest(
      request("/v1/workflows", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body,
      }),
      deps(fetchImpl),
    );
    expect(missingKey?.status).toBe(400);
    expect(await missingKey?.text()).toContain("missing_idempotency_key");
    expect(upstreamCalls).toBe(0);
  });
});

describe("public workflow status", () => {
  test("projects workflow state and rejects task type confusion", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const id = Number(new URL(String(input)).pathname.split("/").at(-1));
      return Response.json(queueSnapshot(id, id === 9 ? "hash.compute" : "workflow.run", "RUNNING"));
    };

    const status = await handlePublicWorkflowRequest(
      request("/v1/workflows/8", { headers: authHeaders() }),
      deps(fetchImpl),
    );
    expect(status?.status).toBe(200);
    expect(await status?.json()).toEqual({
      workflow_id: 8,
      status: "RUNNING",
      retry_count: 0,
      created_at: 1,
      updated_at: 2,
    });

    const wrongType = await handlePublicWorkflowRequest(
      request("/v1/workflows/9", { headers: authHeaders() }),
      deps(fetchImpl),
    );
    expect(wrongType?.status).toBe(404);
    expect(await wrongType?.text()).toContain("workflow_not_found");
  });

  test("projects CANCELLED as a first-class workflow terminal state", async () => {
    const fetchImpl: FetchLike = async () => Response.json(queueSnapshot(18, "workflow.run", "CANCELLED"));
    const response = await handlePublicWorkflowRequest(
      request("/v1/workflows/18", { headers: authHeaders() }),
      deps(fetchImpl),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      workflow_id: 18,
      status: "CANCELLED",
      retry_count: 0,
      created_at: 1,
      updated_at: 2,
    });
  });
});

describe("public workflow cancellation", () => {
  test("validates workflow identity before revoking parent authority", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/v1/tasks/81" && (init?.method ?? "GET") === "GET") {
        return Response.json(queueSnapshot(81, "workflow.run", "RUNNING"));
      }
      if (path === "/v1/tasks/81/cancel" && init?.method === "POST") {
        return Response.json({ task_id: 81, status: "CANCELLED", cancellation: "applied" });
      }
      throw new Error(`unexpected upstream request: ${init?.method ?? "GET"} ${path}`);
    };

    const response = await handlePublicWorkflowRequest(
      request("/v1/workflows/81/cancel", { method: "POST", headers: authHeaders() }),
      deps(fetchImpl),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ workflow_id: 81, status: "CANCELLED", replayed: false });
    expect(calls).toEqual(["GET /v1/tasks/81", "POST /v1/tasks/81/cancel"]);
  });

  test("cannot use the workflow facade to cancel a non-workflow task", async () => {
    let cancelCalls = 0;
    const fetchImpl: FetchLike = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/tasks/82") {
        return Response.json(queueSnapshot(82, "hash.compute", "RUNNING"));
      }
      if (path.endsWith("/cancel") && init?.method === "POST") cancelCalls += 1;
      throw new Error(`unexpected upstream request: ${path}`);
    };

    const response = await handlePublicWorkflowRequest(
      request("/v1/workflows/82/cancel", { method: "POST", headers: authHeaders() }),
      deps(fetchImpl),
    );
    expect(response?.status).toBe(404);
    expect(await response?.text()).toContain("workflow_not_found");
    expect(cancelCalls).toBe(0);
  });

  test("replays an already-cancelled workflow without mutating the fence again", async () => {
    let cancelCalls = 0;
    const fetchImpl: FetchLike = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/tasks/83") {
        return Response.json(queueSnapshot(83, "workflow.run", "CANCELLED"));
      }
      if (path.endsWith("/cancel") && init?.method === "POST") cancelCalls += 1;
      throw new Error(`unexpected upstream request: ${path}`);
    };

    const response = await handlePublicWorkflowRequest(
      request("/v1/workflows/83/cancel", { method: "POST", headers: authHeaders() }),
      deps(fetchImpl),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ workflow_id: 83, status: "CANCELLED", replayed: true });
    expect(cancelCalls).toBe(0);
  });

  test("does not overwrite a workflow that already completed", async () => {
    let cancelCalls = 0;
    const fetchImpl: FetchLike = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/tasks/84") {
        return Response.json(queueSnapshot(84, "workflow.run", "COMPLETED"));
      }
      if (path.endsWith("/cancel") && init?.method === "POST") cancelCalls += 1;
      throw new Error(`unexpected upstream request: ${path}`);
    };

    const response = await handlePublicWorkflowRequest(
      request("/v1/workflows/84/cancel", { method: "POST", headers: authHeaders() }),
      deps(fetchImpl),
    );
    expect(response?.status).toBe(409);
    expect(await response?.text()).toContain("workflow_not_cancellable");
    expect(cancelCalls).toBe(0);
  });

  test("maps a completion-vs-cancel race to a terminal conflict", async () => {
    const fetchImpl: FetchLike = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/tasks/85") return Response.json(queueSnapshot(85, "workflow.run", "RUNNING"));
      if (path === "/v1/tasks/85/cancel" && init?.method === "POST") {
        return new Response('{"error":"already terminal"}', { status: 409 });
      }
      throw new Error(`unexpected upstream request: ${path}`);
    };

    const response = await handlePublicWorkflowRequest(
      request("/v1/workflows/85/cancel", { method: "POST", headers: authHeaders() }),
      deps(fetchImpl),
    );
    expect(response?.status).toBe(409);
    expect(await response?.text()).toContain("workflow_not_cancellable");
  });

  test("inherits bearer authorization before any cancellation I/O", async () => {
    let upstreamCalls = 0;
    const fetchImpl: FetchLike = async () => {
      upstreamCalls += 1;
      return new Response();
    };
    const response = await handlePublicWorkflowRequest(
      request("/v1/workflows/86/cancel", { method: "POST" }),
      deps(fetchImpl),
    );
    expect(response?.status).toBe(401);
    expect(upstreamCalls).toBe(0);
  });
});

describe("public workflow result", () => {
  test("exports exact parent topology without exposing result_json wrapper", async () => {
    const projection = {
      schema_version: 1,
      workflow_task_id: 52,
      status: "COMPLETED",
      steps: [
        { id: "source", type: "hash.compute", task_id: 53, status: "COMPLETED" },
        { id: "agent", type: "agent.invoke", task_id: 54, status: "COMPLETED" },
      ],
    };
    const resultJson = JSON.stringify(projection);
    let resultReads = 0;
    const fetchImpl: FetchLike = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/tasks/52") return Response.json(queueSnapshot(52));
      if (path === "/v1/tasks/52/result") {
        resultReads += 1;
        return Response.json({
          task_id: 52,
          result_json: resultJson,
          result_bytes: new TextEncoder().encode(resultJson).byteLength,
        });
      }
      throw new Error(`unexpected upstream path ${path}`);
    };

    const response = await handlePublicWorkflowRequest(
      request("/v1/workflows/52/result", { headers: authHeaders() }),
      deps(fetchImpl),
    );
    expect(response?.status).toBe(200);
    expect(resultReads).toBe(1);
    const body = await response?.json();
    expect(body).toEqual({
      schema_version: 1,
      workflow_id: 52,
      status: "COMPLETED",
      steps: projection.steps,
    });
    expect(JSON.stringify(body)).not.toContain("result_json");
    expect(JSON.stringify(body)).not.toContain("result_bytes");
  });

  test("does not read a result before completion", async () => {
    let resultReads = 0;
    const fetchImpl: FetchLike = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/tasks/61") return Response.json(queueSnapshot(61, "workflow.run", "RUNNING"));
      if (path.endsWith("/result")) resultReads += 1;
      return new Response(null, { status: 404 });
    };

    const response = await handlePublicWorkflowRequest(
      request("/v1/workflows/61/result", { headers: authHeaders() }),
      deps(fetchImpl),
    );
    expect(response?.status).toBe(409);
    expect(resultReads).toBe(0);
  });

  test("does not expose a result for a cancelled workflow", async () => {
    let resultReads = 0;
    const fetchImpl: FetchLike = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/tasks/62") return Response.json(queueSnapshot(62, "workflow.run", "CANCELLED"));
      if (path.endsWith("/result")) resultReads += 1;
      return new Response(null, { status: 404 });
    };
    const response = await handlePublicWorkflowRequest(
      request("/v1/workflows/62/result", { headers: authHeaders() }),
      deps(fetchImpl),
    );
    expect(response?.status).toBe(409);
    expect(await response?.text()).toContain("CANCELLED");
    expect(resultReads).toBe(0);
  });

  test("fails closed if the stored parent projection contains undeclared fields", async () => {
    const projection = {
      schema_version: 1,
      workflow_task_id: 70,
      status: "COMPLETED",
      steps: [{ id: "x", type: "hash.compute", task_id: 71, status: "COMPLETED" }],
      secret: "must-not-cross-public-boundary",
    };
    const resultJson = JSON.stringify(projection);
    const fetchImpl: FetchLike = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/tasks/70") return Response.json(queueSnapshot(70));
      if (path === "/v1/tasks/70/result") {
        return Response.json({
          task_id: 70,
          result_json: resultJson,
          result_bytes: new TextEncoder().encode(resultJson).byteLength,
        });
      }
      throw new Error(`unexpected upstream path ${path}`);
    };

    const response = await handlePublicWorkflowRequest(
      request("/v1/workflows/70/result", { headers: authHeaders() }),
      deps(fetchImpl),
    );
    expect(response?.status).toBe(502);
    expect(await response?.text()).toContain("invalid_queue_response");
  });
});
