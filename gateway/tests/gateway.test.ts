import { describe, expect, test } from "bun:test";

import {
  TokenBucketAdmissionController,
  type AdmissionController,
} from "../src/admission";
import { handleRequest, type FetchLike } from "../src/app";
import { loadGatewayConfig, type GatewayConfig } from "../src/config";
import { TASK_REGISTRY } from "../src/registry";

const config: GatewayConfig = {
  hostname: "127.0.0.1",
  port: 3000,
  queueDaemonOrigin: "http://127.0.0.1:7331",
  apiToken: "test-secret",
  allowUnauthenticated: false,
  upstreamTimeoutMs: 1_000,
  enqueueRatePerSecond: 10,
  enqueueBurst: 20,
};

const allowAllAdmission: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, init);
}

function taskHeaders(idempotencyKey = "test-request-1"): HeadersInit {
  return {
    authorization: "Bearer test-secret",
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };
}

function dependencies(
  fetchImpl?: FetchLike,
  admissionController: AdmissionController = allowAllAdmission,
) {
  return {
    config,
    registry: TASK_REGISTRY,
    admissionController,
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}

describe("gateway config", () => {
  test("fails closed without authentication configuration", () => {
    expect(() => loadGatewayConfig({})).toThrow("GATEWAY_API_TOKEN is required");
  });

  test("allows explicit unauthenticated local development", () => {
    const value = loadGatewayConfig({ GATEWAY_ALLOW_UNAUTHENTICATED: "1" });
    expect(value.allowUnauthenticated).toBe(true);
    expect(value.hostname).toBe("127.0.0.1");
    expect(value.enqueueRatePerSecond).toBe(10);
    expect(value.enqueueBurst).toBe(20);
  });

  test("accepts bounded admission tuning and rejects invalid values", () => {
    const value = loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_ENQUEUE_RATE_PER_SECOND: "250",
      GATEWAY_ENQUEUE_BURST: "500",
    });
    expect(value.enqueueRatePerSecond).toBe(250);
    expect(value.enqueueBurst).toBe(500);

    expect(() =>
      loadGatewayConfig({
        GATEWAY_API_TOKEN: "secret",
        GATEWAY_ENQUEUE_RATE_PER_SECOND: "0",
      }),
    ).toThrow("GATEWAY_ENQUEUE_RATE_PER_SECOND");
  });

  test("rejects non-loopback gateway and queue addresses", () => {
    expect(() =>
      loadGatewayConfig({
        GATEWAY_API_TOKEN: "secret",
        GATEWAY_HOST: "0.0.0.0",
      }),
    ).toThrow("numeric loopback");

    expect(() =>
      loadGatewayConfig({
        GATEWAY_API_TOKEN: "secret",
        QUEUE_DAEMON_URL: "http://192.168.1.5:7331",
      }),
    ).toThrow("numeric loopback");
  });
});

describe("admission controller", () => {
  test("bounds bursts and refills from monotonic elapsed time", () => {
    let now = 0;
    const admission = new TokenBucketAdmissionController(2, 2, () => now);

    expect(admission.tryAcquire().allowed).toBe(true);
    expect(admission.tryAcquire().allowed).toBe(true);

    const limited = admission.tryAcquire();
    expect(limited.allowed).toBe(false);
    expect(limited.retryAfterSeconds).toBe(1);

    now = 500;
    expect(admission.tryAcquire().allowed).toBe(true);
  });
});

describe("gateway policy boundary", () => {
  test("health is local gateway liveness and ends with a newline", async () => {
    const response = await handleRequest(request("/healthz"), dependencies());

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"status":"ok"');
    expect(body.endsWith("\n")).toBe(true);
  });

  test("protected task routes require bearer auth before other policy", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return new Response();
    };

    const response = await handleRequest(
      request("/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "document.process", payload: { id: "a" } }),
      }),
      dependencies(fetchImpl),
    );

    expect(response.status).toBe(401);
    expect(called).toBe(false);
  });

  test("task creation requires a bounded Idempotency-Key", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return new Response();
    };

    const missing = await handleRequest(
      request("/v1/tasks", {
        method: "POST",
        headers: {
          authorization: "Bearer test-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "document.process", payload: { id: "a" } }),
      }),
      dependencies(fetchImpl),
    );
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("missing_idempotency_key");

    const invalid = await handleRequest(
      request("/v1/tasks", {
        method: "POST",
        headers: taskHeaders("contains spaces"),
        body: JSON.stringify({ type: "document.process", payload: { id: "a" } }),
      }),
      dependencies(fetchImpl),
    );
    expect(invalid.status).toBe(400);
    expect(called).toBe(false);
  });

  test("unregistered task types fail before reaching Rust", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return new Response();
    };

    const response = await handleRequest(
      request("/v1/tasks", {
        method: "POST",
        headers: taskHeaders(),
        body: JSON.stringify({ type: "shell.exec", payload: { command: "id" } }),
      }),
      dependencies(fetchImpl),
    );

    expect(response.status).toBe(422);
    expect(called).toBe(false);
  });

  test("caller cannot inject queue kind through the public schema", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return new Response();
    };

    const response = await handleRequest(
      request("/v1/tasks", {
        method: "POST",
        headers: taskHeaders(),
        body: JSON.stringify({
          type: "document.process",
          kind: "gpu",
          payload: { id: "a" },
        }),
      }),
      dependencies(fetchImpl),
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("registered task is fingerprinted and translated to the private Rust contract", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const fetchImpl: FetchLike = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json(
        { task_id: 7, status: "PENDING", idempotency: "created" },
        { status: 202 },
      );
    };

    const response = await handleRequest(
      request("/v1/tasks", {
        method: "POST",
        headers: taskHeaders("request-abc"),
        body: JSON.stringify({
          type: "document.process",
          payload: { document_id: "abc" },
          priority: 10,
          max_retries: 3,
        }),
      }),
      dependencies(fetchImpl),
    );

    expect(response.status).toBe(202);
    expect(capturedUrl).toBe("http://127.0.0.1:7331/v1/tasks");

    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("x-task-name")).toBe("document.process");
    expect(headers.get("x-task-type")).toBe("cpu");
    expect(headers.get("x-task-priority")).toBe("10");
    expect(headers.get("x-task-max-retries")).toBe("3");
    expect(headers.get("x-idempotency-key")).toBe("request-abc");
    expect(headers.get("x-request-fingerprint")).toMatch(/^[0-9a-f]{64}$/);
    expect(capturedInit?.body).toBe('{"document_id":"abc"}');

    expect(await response.json()).toEqual({
      task_id: 7,
      status: "PENDING",
      replayed: false,
    });
  });

  test("canonical fingerprint is stable across object key order", async () => {
    const fingerprints: string[] = [];
    let call = 0;
    const fetchImpl: FetchLike = async (_input, init) => {
      fingerprints.push(new Headers(init?.headers).get("x-request-fingerprint") ?? "");
      call += 1;
      return Response.json(
        {
          task_id: 9,
          status: "PENDING",
          idempotency: call === 1 ? "created" : "replayed",
        },
        { status: 202 },
      );
    };

    const first = await handleRequest(
      request("/v1/tasks", {
        method: "POST",
        headers: taskHeaders("stable-key"),
        body: JSON.stringify({
          type: "document.process",
          payload: { a: 1, nested: { x: true, y: false } },
        }),
      }),
      dependencies(fetchImpl),
    );
    const second = await handleRequest(
      request("/v1/tasks", {
        method: "POST",
        headers: taskHeaders("stable-key"),
        body: JSON.stringify({
          payload: { nested: { y: false, x: true }, a: 1 },
          type: "document.process",
        }),
      }),
      dependencies(fetchImpl),
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[0]).toBe(fingerprints[1]);
    expect((await second.json()).replayed).toBe(true);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
  });

  test("upstream idempotency conflict is not hidden", async () => {
    const fetchImpl: FetchLike = async () =>
      Response.json({ error: "conflict" }, { status: 409 });

    const response = await handleRequest(
      request("/v1/tasks", {
        method: "POST",
        headers: taskHeaders("conflict-key"),
        body: JSON.stringify({ type: "document.process", payload: { id: 1 } }),
      }),
      dependencies(fetchImpl),
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("idempotency_conflict");
  });

  test("rate limit rejects excess valid enqueue before Rust and returns Retry-After", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return Response.json(
        { task_id: calls, status: "PENDING", idempotency: "created" },
        { status: 202 },
      );
    };
    const admission = new TokenBucketAdmissionController(1, 1, () => 0);

    const first = await handleRequest(
      request("/v1/tasks", {
        method: "POST",
        headers: taskHeaders("rate-1"),
        body: JSON.stringify({ type: "document.process", payload: { id: 1 } }),
      }),
      dependencies(fetchImpl, admission),
    );
    const second = await handleRequest(
      request("/v1/tasks", {
        method: "POST",
        headers: taskHeaders("rate-2"),
        body: JSON.stringify({ type: "document.process", payload: { id: 2 } }),
      }),
      dependencies(fetchImpl, admission),
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("1");
    expect(calls).toBe(1);
  });

  test("ready fails closed when the queue daemon is unavailable", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connection refused");
    };

    const response = await handleRequest(
      request("/readyz"),
      dependencies(fetchImpl),
    );

    expect(response.status).toBe(503);
  });

  test("task query strips fields outside the public snapshot contract", async () => {
    const fetchImpl: FetchLike = async () =>
      Response.json({
        id: 7,
        task_name: "document.process",
        task_type: "cpu",
        priority: 10,
        max_retries: 3,
        retry_count: 0,
        status: "PENDING",
        locked_by: null,
        locked_until: null,
        heartbeat_at: null,
        error_log: null,
        scheduled_at: 1,
        created_at: 1,
        updated_at: 1,
        lease_generation: 0,
        payload: { secret: true },
      });

    const response = await handleRequest(
      request("/v1/tasks/7", {
        headers: { authorization: "Bearer test-secret" },
      }),
      dependencies(fetchImpl),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe(7);
    expect("payload" in body).toBe(false);
  });
});
