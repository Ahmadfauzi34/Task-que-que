import { describe, expect, test } from "bun:test";

import {
  MAX_WORKFLOW_OUTPUTS,
  executeWorkflowWithDeclaredOutputs,
  parseDeclaredWorkflow,
} from "../src/declared-outputs";
import { WorkflowPayloadError } from "../src/workflow-handler";

function projection(taskId: number, value: unknown): Response {
  const resultJson = JSON.stringify(value);
  return Response.json({
    task_id: taskId,
    result_json: resultJson,
    result_bytes: new TextEncoder().encode(resultJson).byteLength,
  });
}

describe("declared workflow outputs", () => {
  test("accepts exact named output references and keeps outputs optional", () => {
    const declared = parseDeclaredWorkflow(
      JSON.stringify({
        steps: [{ id: "agent", type: "agent.invoke", payload: { input: "x" } }],
        outputs: {
          answer: { $from: "agent", path: "result.answer" },
        },
      }),
    );
    expect(declared.outputs.answer).toEqual({ $from: "agent", path: "result.answer" });

    const compatible = parseDeclaredWorkflow(
      JSON.stringify({
        steps: [{ id: "agent", type: "agent.invoke", payload: { input: "x" } }],
      }),
    );
    expect(compatible.outputs).toEqual({});
  });

  test("rejects unknown sources, nested output templates, unsafe names, and excessive outputs", () => {
    const step = { id: "agent", type: "agent.invoke", payload: { input: "x" } };
    const invalid = [
      { steps: [step], outputs: { answer: { $from: "missing", path: "result.answer" } } },
      { steps: [step], outputs: { answer: { value: { $from: "agent", path: "result.answer" } } } },
      { steps: [step], outputs: JSON.parse('{"__proto__":{"$from":"agent","path":"result.answer"}}') },
    ];
    for (const value of invalid) {
      expect(() => parseDeclaredWorkflow(JSON.stringify(value))).toThrow(WorkflowPayloadError);
    }

    const tooMany: Record<string, unknown> = {};
    for (let index = 0; index <= MAX_WORKFLOW_OUTPUTS; index += 1) {
      tooMany[`o${index}`] = { $from: "agent", path: "result.answer" };
    }
    expect(() => parseDeclaredWorkflow(JSON.stringify({ steps: [step], outputs: tooMany }))).toThrow(
      `at most ${MAX_WORKFLOW_OUTPUTS}`,
    );
  });

  test("resolves declared fields only after the source task is completed", async () => {
    let nextTaskId = 501;
    const taskNames = new Map<number, string>();
    const gatewayFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname === "/v1/tasks") {
        const body = JSON.parse(String(init.body)) as { type: string };
        const taskId = nextTaskId++;
        taskNames.set(taskId, body.type);
        return Response.json({ task_id: taskId, status: "PENDING", replayed: false }, { status: 202 });
      }
      const match = /^\/v1\/tasks\/(\d+)$/.exec(url.pathname);
      if (match) {
        const taskId = Number(match[1]);
        return Response.json({ id: taskId, task_name: taskNames.get(taskId), status: "COMPLETED" });
      }
      return new Response("not found", { status: 404 });
    };
    const resultFetch: typeof fetch = async (input) => {
      const match = /\/v1\/tasks\/(\d+)\/result$/.exec(new URL(String(input)).pathname);
      if (!match) return new Response("not found", { status: 404 });
      return projection(Number(match[1]), {
        schema_version: 1,
        result: { answer: "bounded-answer", confidence: 0.93 },
        meta: { hidden: "not-exported" },
      });
    };

    const result = await executeWorkflowWithDeclaredOutputs(
      90,
      JSON.stringify({
        steps: [{ id: "agent", type: "agent.invoke", payload: { input: "x" } }],
        outputs: {
          answer: { $from: "agent", path: "result.answer" },
          confidence: { $from: "agent", path: "result.confidence" },
        },
      }),
      {
        origin: "http://127.0.0.1:3000",
        bearerToken: "token",
        requestTimeoutMs: 2_000,
        pollMs: 25,
        maxRunMs: 5_000,
        fetchImpl: gatewayFetch,
        resultOrigin: "http://127.0.0.1:7331",
        resultFetchImpl: resultFetch,
      },
    );

    expect(result.outputs).toEqual({ answer: "bounded-answer", confidence: 0.93 });
    expect(JSON.stringify(result.outputs)).not.toContain("hidden");
  });

  test("fails closed when a declared source has no durable projection", async () => {
    const gatewayFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST") {
        return Response.json({ task_id: 601, status: "PENDING", replayed: false }, { status: 202 });
      }
      if (url.pathname === "/v1/tasks/601") {
        return Response.json({ id: 601, task_name: "agent.invoke", status: "COMPLETED" });
      }
      return new Response("not found", { status: 404 });
    };

    await expect(
      executeWorkflowWithDeclaredOutputs(
        91,
        JSON.stringify({
          steps: [{ id: "agent", type: "agent.invoke", payload: { input: "x" } }],
          outputs: { answer: { $from: "agent", path: "result.answer" } },
        }),
        {
          origin: "http://127.0.0.1:3000",
          bearerToken: "token",
          requestTimeoutMs: 2_000,
          pollMs: 25,
          maxRunMs: 5_000,
          fetchImpl: gatewayFetch,
          resultOrigin: "http://127.0.0.1:7331",
          resultFetchImpl: async () => new Response("not found", { status: 404 }),
        },
      ),
    ).rejects.toThrow("no result projection");
  });
});
