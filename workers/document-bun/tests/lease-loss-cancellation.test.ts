import { describe, expect, test } from "bun:test";

import {
  WorkerHandlerRegistry,
  type WorkerHandler,
} from "../src/registry";
import { runWorker } from "../src/worker";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for lease-loss proof state");
    }
    await Bun.sleep(10);
  }
}

describe("cooperative lease-loss cancellation", () => {
  test("aborts the active handler and suppresses terminal transitions after heartbeat rejection", async () => {
    let claimIssued = false;
    let taskHeartbeats = 0;
    let failTransitions = 0;
    let completeTransitions = 0;
    let handlerStarted = false;
    let handlerAborted = false;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;

        if (request.method === "POST" && path === "/v1/register") {
          if (request.headers.get("x-worker-tasks") !== "lease.proof") {
            return new Response('{"error":"task advertisement mismatch"}', { status: 400 });
          }
          return Response.json({
            worker_id: "lease-proof-worker",
            worker_type: "cpu",
            capacity: 1,
            task_names: ["lease.proof"],
            session_id: "0123456789abcdef0123456789abcdef",
            session_token:
              "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            session_ttl_ms: 300,
            task_lease_ms: 150,
          });
        }

        if (request.method === "POST" && path === "/v1/claim") {
          if (claimIssued) {
            return new Response(null, { status: 204 });
          }
          claimIssued = true;
          return Response.json({
            task_id: 41,
            task_name: "lease.proof",
            task_type: "cpu",
            payload: "{}",
            retry_count: 0,
            max_retries: 1,
            lease_generation: 1,
            lease_ms: 150,
          });
        }

        if (request.method === "POST" && path === "/v1/session/heartbeat") {
          return Response.json({ status: "alive" });
        }

        if (request.method === "POST" && path === "/v1/task/heartbeat") {
          taskHeartbeats += 1;
          return Response.json({ error: "stale fence" }, { status: 409 });
        }

        if (request.method === "POST" && path === "/v1/task/fail") {
          failTransitions += 1;
          return Response.json({ status: "failed" });
        }

        if (request.method === "POST" && path === "/v1/task/complete") {
          completeTransitions += 1;
          return Response.json({ status: "completed" });
        }

        return new Response(null, { status: 404 });
      },
    });

    const handler: WorkerHandler = {
      taskName: "lease.proof",
      taskType: "cpu",
      async handle(_task, context) {
        handlerStarted = true;
        await new Promise<void>((_resolve, reject) => {
          const abort = () => {
            handlerAborted = true;
            reject(new Error("handler observed lease-loss abort"));
          };
          if (context.signal.aborted) {
            abort();
            return;
          }
          context.signal.addEventListener("abort", abort, { once: true });
        });
      },
    };

    const registry = new WorkerHandlerRegistry("cpu", [handler]);
    const stop = new AbortController();

    try {
      const running = runWorker(
        {
          origin: `http://127.0.0.1:${server.port}`,
          workerId: "lease-proof-worker",
          outputDir: ".",
          capacity: 1,
          pollMs: 10,
          processDelayMs: 0,
          requestTimeoutMs: 1_000,
        },
        stop.signal,
        registry,
      );

      await waitFor(() => handlerAborted);
      stop.abort();
      await running;

      expect(handlerStarted).toBe(true);
      expect(handlerAborted).toBe(true);
      expect(taskHeartbeats).toBe(1);
      expect(failTransitions).toBe(0);
      expect(completeTransitions).toBe(0);
    } finally {
      stop.abort();
      server.stop(true);
    }
  });
});
