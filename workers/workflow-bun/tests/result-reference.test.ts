import { afterEach, describe, expect, test } from "bun:test";

import {
  MAX_WORKFLOW_RESULT_REFERENCES,
  WorkflowResultReadError,
  WorkflowResultReferenceError,
  normalizeWorkflowResultOrigin,
  parseResultPath,
  resolveResultReferences,
  validateResultReferencePayload,
} from "../src/result-reference";
import {
  WorkflowPayloadError,
  executeWorkflow,
  parseWorkflowDefinition,
} from "../src/workflow-handler";

const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function projectionWrapper(taskId: number, projection: Record<string, unknown>) {
  const resultJson = JSON.stringify(projection);
  return {
    task_id: taskId,
    result_json: resultJson,
    result_bytes: new TextEncoder().encode(resultJson).byteLength,
  };
}

describe("bounded result reference syntax", () => {
  test("accepts exact paths and rejects dangerous or unbounded paths", () => {
    expect(parseResultPath("digest")).toEqual(["digest"]);
    expect(parseResultPath("result.items.0.id")).toEqual(["result", "items", "0", "id"]);
    expect(() => parseResultPath("__proto__.x")).toThrow(WorkflowResultReferenceError);
    expect(() => parseResultPath("result.constructor")).toThrow(WorkflowResultReferenceError);
    expect(() => parseResultPath(Array.from({ length: 9 }, () => "x").join("."))).toThrow(
      WorkflowResultReferenceError,
    );
  });

  test("reserves $from objects and bounds reference count", () => {
    expect(() =>
      validateResultReferencePayload(
        { value: { $from: "a", path: "digest", extra: true } },
        new Set(["a"]),
      ),
    ).toThrow(WorkflowResultReferenceError);

    const many = Array.from({ length: MAX_WORKFLOW_RESULT_REFERENCES + 1 }, () => ({
      $from: "a",
      path: "digest",
    }));
    expect(() => validateResultReferencePayload(many, new Set(["a"]))).toThrow(
      WorkflowResultReferenceError,
    );
  });

  test("keeps result reads on loopback only", () => {
    expect(normalizeWorkflowResultOrigin("http://127.0.0.1:7331")).toBe(
      "http://127.0.0.1:7331",
    );
    expect(() => normalizeWorkflowResultOrigin("https://example.com")).toThrow();
    expect(() => normalizeWorkflowResultOrigin("http://192.0.2.10:7331")).toThrow();
  });
});

describe("workflow data authority", () => {
  test("allows references only to transitive ancestors", () => {
    const valid = parseWorkflowDefinition(
      JSON.stringify({
        steps: [
          { id: "source", type: "hash.compute", payload: { data: "x", algorithm: "sha256" } },
          { id: "middle", type: "vector.dot", payload: { a: [1], b: [1] }, depends_on: ["source"] },
          {
            id: "sink",
            type: "agent.invoke",
            payload: { input: { digest: { $from: "source", path: "digest" } } },
            depends_on: ["middle"],
          },
        ],
      }),
    );
    expect(valid.steps[2]?.id).toBe("sink");

    expect(() =>
      parseWorkflowDefinition(
        JSON.stringify({
          steps: [
            { id: "a", type: "hash.compute", payload: { data: "a", algorithm: "sha256" } },
            { id: "b", type: "hash.compute", payload: { data: "b", algorithm: "sha256" } },
            {
              id: "sink",
              type: "agent.invoke",
              payload: { input: { digest: { $from: "a", path: "digest" } } },
              depends_on: ["b"],
            },
          ],
        }),
      ),
    ).toThrow(WorkflowPayloadError);
  });

  test("rejects root references before any workflow child can be submitted", () => {
    expect(() =>
      parseWorkflowDefinition(
        JSON.stringify({
          steps: [
            {
              id: "root",
              type: "agent.invoke",
              payload: { input: { value: { $from: "other", path: "digest" } } },
            },
            { id: "other", type: "hash.compute", payload: { data: "x", algorithm: "sha256" } },
          ],
        }),
      ),
    ).toThrow(WorkflowPayloadError);
  });
});

describe("result resolution", () => {
  test("reads one bounded projection and resolves repeated exact paths", async () => {
    let reads = 0;
    const resultServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/tasks/41/result") {
          reads += 1;
          return Response.json(
            projectionWrapper(41, {
              digest: "abc123",
              result: { items: [{ id: "first" }] },
            }),
          );
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    servers.push(resultServer);

    const resolved = await resolveResultReferences(
      {
        first: { $from: "source", path: "digest" },
        second: { $from: "source", path: "result.items.0.id" },
      },
      new Map([["source", 41]]),
      {
        origin: `http://127.0.0.1:${resultServer.port}`,
        requestTimeoutMs: 2_000,
      },
    );

    expect(resolved).toEqual({ first: "abc123", second: "first" });
    expect(reads).toBe(1);
  });

  test("fails closed when a completed source has no projection", async () => {
    const resultServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ error: "task result not found" }, { status: 404 });
      },
    });
    servers.push(resultServer);

    await expect(
      resolveResultReferences(
        { value: { $from: "source", path: "digest" } },
        new Map([["source", 9]]),
        {
          origin: `http://127.0.0.1:${resultServer.port}`,
          requestTimeoutMs: 2_000,
        },
      ),
    ).rejects.toThrow(WorkflowResultReadError);
  });
});

describe("workflow result dataflow", () => {
  test("submits a dependent child with the resolved ancestor projection value", async () => {
    let nextTaskId = 100;
    const taskNames = new Map<number, string>();
    const posted: Array<{ type: string; payload: unknown }> = [];

    const gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer workflow-token");
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/v1/tasks") {
          const body = (await request.json()) as { type: string; payload: unknown };
          posted.push(body);
          const taskId = nextTaskId++;
          taskNames.set(taskId, body.type);
          return Response.json({ task_id: taskId, status: "PENDING", replayed: false }, { status: 202 });
        }
        const match = url.pathname.match(/^\/v1\/tasks\/(\d+)$/);
        if (request.method === "GET" && match) {
          const taskId = Number(match[1]);
          return Response.json({ id: taskId, task_name: taskNames.get(taskId), status: "COMPLETED" });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    servers.push(gateway);

    const resultServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/tasks/100/result") {
          return Response.json(
            projectionWrapper(100, {
              schema_version: 1,
              task_id: 100,
              digest: "feedface",
            }),
          );
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    servers.push(resultServer);

    const result = await executeWorkflow(
      77,
      JSON.stringify({
        steps: [
          {
            id: "source",
            type: "hash.compute",
            payload: { data: "source text", algorithm: "sha256" },
          },
          {
            id: "sink",
            type: "agent.invoke",
            payload: {
              request_id: "dataflow-test",
              input: { digest: { $from: "source", path: "digest" } },
            },
            depends_on: ["source"],
          },
        ],
      }),
      {
        origin: `http://127.0.0.1:${gateway.port}`,
        resultOrigin: `http://127.0.0.1:${resultServer.port}`,
        bearerToken: "workflow-token",
        requestTimeoutMs: 2_000,
        pollMs: 25,
        maxRunMs: 5_000,
      },
    );

    expect(result.status).toBe("COMPLETED");
    expect(posted).toHaveLength(2);
    expect(posted[0]).toEqual({
      type: "hash.compute",
      payload: { data: "source text", algorithm: "sha256" },
    });
    expect(posted[1]).toEqual({
      type: "agent.invoke",
      payload: { request_id: "dataflow-test", input: { digest: "feedface" } },
    });
    expect(JSON.stringify(posted[1])).not.toContain("$from");
  });
});
