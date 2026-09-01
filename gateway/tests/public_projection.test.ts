import { expect, test } from "bun:test";

import type { AdmissionController } from "../src/admission";
import { handleRequest, type FetchLike } from "../src/app";
import type { GatewayConfig } from "../src/config";
import { TASK_REGISTRY } from "../src/registry";

const config: GatewayConfig = {
  hostname: "127.0.0.1",
  port: 3000,
  queueDaemonOrigin: "http://127.0.0.1:7331",
  apiToken: "projection-secret",
  allowUnauthenticated: false,
  upstreamTimeoutMs: 1_000,
  enqueueRatePerSecond: 10,
  enqueueBurst: 20,
  maxActiveTasks: 256,
};

const admissionController: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

test("public task snapshots exclude worker, lease, and error internals", async () => {
  const fetchImpl: FetchLike = async () =>
    Response.json({
      id: 9,
      task_name: "document.process",
      task_type: "cpu",
      priority: 10,
      max_retries: 3,
      retry_count: 0,
      status: "RUNNING",
      locked_by: "worker-session-secretish-id",
      locked_until: 123,
      heartbeat_at: 122,
      error_log: "worker_error:private_detail",
      scheduled_at: 1,
      created_at: 1,
      updated_at: 2,
      lease_generation: 77,
      payload: { text: "secret document" },
    });

  const response = await handleRequest(
    new Request("http://127.0.0.1:3000/v1/tasks/9", {
      headers: { authorization: "Bearer projection-secret" },
    }),
    { config, registry: TASK_REGISTRY, admissionController, fetchImpl },
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toEqual({
    id: 9,
    task_name: "document.process",
    task_type: "cpu",
    priority: 10,
    max_retries: 3,
    retry_count: 0,
    status: "RUNNING",
    scheduled_at: 1,
    created_at: 1,
    updated_at: 2,
  });

  for (const forbidden of [
    "payload",
    "locked_by",
    "locked_until",
    "heartbeat_at",
    "error_log",
    "lease_generation",
  ]) {
    expect(forbidden in body).toBe(false);
  }
});
