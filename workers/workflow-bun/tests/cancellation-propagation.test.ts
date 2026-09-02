import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkflowWorkerRegistry } from "../src/worker";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("workflow cancellation aborts projection I/O before the next child enqueue begins", async () => {
  let enqueueCalls = 0;
  let projectionReadStartedResolve!: () => void;
  const projectionReadStarted = new Promise<void>((resolve) => {
    projectionReadStartedResolve = resolve;
  });

  const gatewayFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.pathname === "/v1/tasks" && init?.method === "POST") {
      enqueueCalls += 1;
      if (enqueueCalls > 1) {
        throw new Error("workflow attempted a post-cancellation child enqueue");
      }
      return Response.json({ task_id: 101, status: "PENDING", replayed: false }, { status: 202 });
    }
    if (url.pathname === "/v1/tasks/101" && init?.method === "GET") {
      return Response.json({
        id: 101,
        task_name: "hash.compute",
        status: "COMPLETED",
      });
    }
    throw new Error(`unexpected gateway request: ${init?.method ?? "GET"} ${url.pathname}`);
  }) as typeof fetch;

  const resultFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    projectionReadStartedResolve();
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(signal?.reason ?? new DOMException("operation aborted", "AbortError"));
      if (signal?.aborted) {
        abort();
      } else {
        signal?.addEventListener("abort", abort, { once: true });
      }
    });
  }) as typeof fetch;

  const registry = createWorkflowWorkerRegistry({
    origin: "http://127.0.0.1:3000",
    resultOrigin: "http://127.0.0.1:7331",
    bearerToken: "proof-token",
    requestTimeoutMs: 2_000,
    pollMs: 25,
    maxRunMs: 2_000,
    fetchImpl: gatewayFetch,
    resultFetchImpl: resultFetch,
  });
  const handler = registry.resolve("workflow.run", "workflow");
  expect(handler).toBeDefined();

  const outputDir = await mkdtemp(join(tmpdir(), "workflow-cancel-proof-"));
  cleanupPaths.push(outputDir);
  const controller = new AbortController();
  const running = handler!.handle(
    {
      task_id: 77,
      task_name: "workflow.run",
      task_type: "workflow",
      payload: JSON.stringify({
        steps: [
          {
            id: "source",
            type: "hash.compute",
            payload: { algorithm: "sha256", data: "proof" },
          },
          {
            id: "sink",
            type: "agent.invoke",
            depends_on: ["source"],
            payload: {
              input: {
                digest: { $from: "source", path: "digest" },
              },
            },
          },
        ],
      }),
    },
    { outputDir, signal: controller.signal },
  );

  await projectionReadStarted;
  controller.abort(new Error("lease authority lost"));

  await expect(running).rejects.toThrow();
  expect(enqueueCalls).toBe(1);
});
