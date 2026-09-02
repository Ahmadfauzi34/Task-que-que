import { describe, expect, test } from "bun:test";

import type { AdmissionController } from "../src/admission";
import type { FetchLike } from "../src/app";
import type { GatewayConfig } from "../src/config";
import { TASK_REGISTRY } from "../src/registry";
import { handleDeclaredWorkflowResultRequest } from "../src/workflow-results";

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
const admission: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

function request(path: string, auth = true): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    headers: auth ? { authorization: "Bearer test-secret" } : {},
  });
}

function wrapper(taskId: number, projection: unknown): Response {
  const resultJson = JSON.stringify(projection);
  return Response.json({
    task_id: taskId,
    result_json: resultJson,
    result_bytes: new TextEncoder().encode(resultJson).byteLength,
  });
}

function dependencies(fetchImpl: FetchLike) {
  return { config, registry: TASK_REGISTRY, admissionController: admission, fetchImpl };
}

describe("declared public workflow results", () => {
  test("requires the existing gateway bearer boundary", async () => {
    let calls = 0;
    const response = await handleDeclaredWorkflowResultRequest(
      request("/v1/workflows/7/result", false),
      dependencies(async () => {
        calls += 1;
        return new Response("unexpected");
      }),
    );
    expect(response?.status).toBe(401);
    expect(calls).toBe(0);
  });

  test("exports only the exact parent outputs object and topology", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/tasks/7") {
        return Response.json({
          id: 7,
          task_name: "workflow.run",
          task_type: "workflow",
          status: "COMPLETED",
        });
      }
      if (path === "/v1/tasks/7/result") {
        return wrapper(7, {
          schema_version: 1,
          workflow_task_id: 7,
          status: "COMPLETED",
          steps: [
            { id: "agent", type: "agent.invoke", task_id: 8, status: "COMPLETED" },
          ],
          outputs: { answer: "bounded", score: 0.9 },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const response = await handleDeclaredWorkflowResultRequest(
      request("/v1/workflows/7/result"),
      dependencies(fetchImpl),
    );
    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.outputs).toEqual({ answer: "bounded", score: 0.9 });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("result_json");
    expect(raw).not.toContain("result_bytes");
    expect(raw).not.toContain("lease_generation");
  });

  test("fails closed on unexpected projection fields and unsafe output names", async () => {
    const projections = [
      {
        schema_version: 1,
        workflow_task_id: 7,
        status: "COMPLETED",
        steps: [{ id: "x", type: "hash.compute", task_id: 8, status: "COMPLETED" }],
        outputs: {},
        secret: "nope",
      },
      JSON.parse(
        '{"schema_version":1,"workflow_task_id":7,"status":"COMPLETED","steps":[{"id":"x","type":"hash.compute","task_id":8,"status":"COMPLETED"}],"outputs":{"__proto__":"nope"}}',
      ),
    ];

    for (const projection of projections) {
      const fetchImpl: FetchLike = async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/tasks/7") {
          return Response.json({ id: 7, task_name: "workflow.run", task_type: "workflow", status: "COMPLETED" });
        }
        if (path === "/v1/tasks/7/result") return wrapper(7, projection);
        return new Response("not found", { status: 404 });
      };
      const response = await handleDeclaredWorkflowResultRequest(
        request("/v1/workflows/7/result"),
        dependencies(fetchImpl),
      );
      expect(response?.status).toBe(502);
    }
  });

  test("does not treat a non-workflow task id as a workflow result", async () => {
    const response = await handleDeclaredWorkflowResultRequest(
      request("/v1/workflows/9/result"),
      dependencies(async () =>
        Response.json({ id: 9, task_name: "hash.compute", task_type: "cpu", status: "COMPLETED" }),
      ),
    );
    expect(response?.status).toBe(404);
  });
});
