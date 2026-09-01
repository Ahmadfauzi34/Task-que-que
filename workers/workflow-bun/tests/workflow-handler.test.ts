import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_WORKFLOW_STEPS,
  WorkflowPayloadError,
  createWorkflowHandler,
  executeWorkflow,
  normalizeWorkflowGatewayOrigin,
  parseWorkflowDefinition,
  writeWorkflowResultAtomic,
} from "../src/workflow-handler";
import {
  createWorkflowWorkerRegistry,
  loadWorkflowWorkerConfig,
} from "../src/worker";

const servers: Bun.Server<unknown>[] = [];
const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("workflow definition", () => {
  test("accepts fan-out and join dependencies", () => {
    const definition = parseWorkflowDefinition(
      JSON.stringify({
        steps: [
          { id: "a", type: "hash.compute", payload: { data: "a", algorithm: "sha256" } },
          { id: "b", type: "vector.dot", payload: { a: [1], b: [2] } },
          {
            id: "join",
            type: "agent.invoke",
            payload: { input: "done" },
            depends_on: ["a", "b"],
          },
        ],
      }),
    );
    expect(definition.steps.map((step) => step.id)).toEqual(["a", "b", "join"]);
    expect(definition.steps[2]?.depends_on).toEqual(["a", "b"]);
  });

  test("rejects cycles, missing dependencies, duplicate ids, recursion, and unknown fields", () => {
    const invalid = [
      { steps: [{ id: "a", type: "hash.compute", payload: {}, depends_on: ["missing"] }] },
      {
        steps: [
          { id: "a", type: "hash.compute", payload: {}, depends_on: ["b"] },
          { id: "b", type: "hash.compute", payload: {}, depends_on: ["a"] },
        ],
      },
      {
        steps: [
          { id: "same", type: "hash.compute", payload: {} },
          { id: "same", type: "hash.compute", payload: {} },
        ],
      },
      { steps: [{ id: "nested", type: "workflow.run", payload: { steps: [] } }] },
      { steps: [{ id: "x", type: "hash.compute", payload: {}, command: "echo nope" }] },
    ];
    for (const value of invalid) {
      expect(() => parseWorkflowDefinition(JSON.stringify(value))).toThrow(WorkflowPayloadError);
    }
  });

  test("keeps the reference step bound explicit rather than implicit", () => {
    const steps = Array.from({ length: MAX_WORKFLOW_STEPS + 1 }, (_, index) => ({
      id: `s${index}`,
      type: "hash.compute",
      payload: { data: String(index), algorithm: "sha256" },
    }));
    expect(() => parseWorkflowDefinition(JSON.stringify({ steps }))).toThrow(
      `at most ${MAX_WORKFLOW_STEPS} steps`,
    );
  });
});

describe("workflow gateway boundary", () => {
  test("keeps child submission on the loopback gateway", () => {
    expect(normalizeWorkflowGatewayOrigin("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000",
    );
    expect(() => normalizeWorkflowGatewayOrigin("https://example.com")).toThrow();
    expect(() => normalizeWorkflowGatewayOrigin("http://192.0.2.10:3000")).toThrow();
  });

  test("declares a dedicated workflow hard capability", () => {
    const config = {
      origin: "http://127.0.0.1:3000",
      bearerToken: "workflow-token",
      requestTimeoutMs: 2_000,
      pollMs: 25,
      maxRunMs: 5_000,
    };
    const handler = createWorkflowHandler(config);
    const registry = createWorkflowWorkerRegistry(config);
    expect(handler.taskName).toBe("workflow.run");
    expect(handler.taskType).toBe("workflow");
    expect(registry.workerType).toBe("workflow");
    expect(registry.resolve("workflow.run", "workflow")).toBeDefined();
    expect(registry.resolve("workflow.run", "cpu")).toBeUndefined();
  });

  test("requires gateway auth in worker configuration", () => {
    expect(() => loadWorkflowWorkerConfig({ WORKFLOW_GATEWAY_API_TOKEN: "" })).toThrow();
    const config = loadWorkflowWorkerConfig({ WORKFLOW_GATEWAY_API_TOKEN: "secret" });
    expect(config.workflow.origin).toBe("http://127.0.0.1:3000");
    expect(config.workflow.bearerToken).toBe("secret");
  });
});

describe("workflow execution", () => {
  test("fans out ready steps, joins only after completion, and uses deterministic child idempotency", async () => {
    let nextTaskId = 100;
    const byKey = new Map<string, number>();
    const taskNames = new Map<number, string>();
    const postOrder: string[] = [];
    const statusReads = new Map<number, number>();

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer workflow-token");
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/v1/tasks") {
          const key = request.headers.get("idempotency-key") ?? "";
          const body = (await request.json()) as { type: string };
          const existing = byKey.get(key);
          const taskId = existing ?? nextTaskId++;
          byKey.set(key, taskId);
          taskNames.set(taskId, body.type);
          postOrder.push(body.type);
          return Response.json(
            { task_id: taskId, status: "PENDING", replayed: existing !== undefined },
            { status: 202 },
          );
        }
        const match = url.pathname.match(/^\/v1\/tasks\/(\d+)$/);
        if (request.method === "GET" && match) {
          const taskId = Number(match[1]);
          const reads = (statusReads.get(taskId) ?? 0) + 1;
          statusReads.set(taskId, reads);
          return Response.json({
            id: taskId,
            task_name: taskNames.get(taskId),
            status: "COMPLETED",
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const result = await executeWorkflow(
      77,
      JSON.stringify({
        steps: [
          { id: "cpu", type: "hash.compute", payload: { data: "x", algorithm: "sha256" } },
          { id: "vec", type: "vector.dot", payload: { a: [1], b: [2] } },
          {
            id: "join",
            type: "agent.invoke",
            payload: { input: "join" },
            depends_on: ["cpu", "vec"],
          },
        ],
      }),
      {
        origin: `http://127.0.0.1:${server.port}`,
        bearerToken: "workflow-token",
        requestTimeoutMs: 2_000,
        pollMs: 25,
        maxRunMs: 5_000,
      },
    );

    expect(postOrder).toEqual(["hash.compute", "vector.dot", "agent.invoke"]);
    expect(Array.from(byKey.keys())).toEqual(["wf-77-cpu", "wf-77-vec", "wf-77-join"]);
    expect(result.status).toBe("COMPLETED");
    expect(result.steps.map((step) => step.id)).toEqual(["cpu", "vec", "join"]);
  });

  test("replays the same child task ids after a workflow handler retry", async () => {
    let nextTaskId = 200;
    const byKey = new Map<string, number>();
    const taskNames = new Map<number, string>();
    const replayFlags: boolean[] = [];

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/v1/tasks") {
          const key = request.headers.get("idempotency-key") ?? "";
          const body = (await request.json()) as { type: string };
          const existing = byKey.get(key);
          const taskId = existing ?? nextTaskId++;
          byKey.set(key, taskId);
          taskNames.set(taskId, body.type);
          replayFlags.push(existing !== undefined);
          return Response.json(
            { task_id: taskId, status: "PENDING", replayed: existing !== undefined },
            { status: 202 },
          );
        }
        const match = url.pathname.match(/^\/v1\/tasks\/(\d+)$/);
        if (request.method === "GET" && match) {
          const taskId = Number(match[1]);
          return Response.json({ id: taskId, task_name: taskNames.get(taskId), status: "COMPLETED" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const payload = JSON.stringify({
      steps: [{ id: "only", type: "hash.compute", payload: { data: "x", algorithm: "sha256" } }],
    });
    const config = {
      origin: `http://127.0.0.1:${server.port}`,
      bearerToken: "workflow-token",
      requestTimeoutMs: 2_000,
      pollMs: 25,
      maxRunMs: 5_000,
    };
    const first = await executeWorkflow(88, payload, config);
    const second = await executeWorkflow(88, payload, config);
    expect(first.steps[0]?.task_id).toBe(second.steps[0]?.task_id);
    expect(replayFlags).toEqual([false, true]);
  });

  test("writes only workflow topology state, not child payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-result-"));
    cleanupPaths.push(dir);
    const result = {
      schema_version: 1 as const,
      workflow_task_id: 9,
      status: "COMPLETED" as const,
      steps: [{ id: "x", type: "hash.compute", task_id: 10, status: "COMPLETED" as const }],
    };
    const path = await writeWorkflowResultAtomic(dir, result);
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toEqual(result);
    expect(raw).not.toContain("payload");
    expect(raw).not.toContain("workflow-token");
  });
});
