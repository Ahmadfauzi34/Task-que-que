import { describe, expect, test } from "bun:test";

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
};

function request(
  path: string,
  init: RequestInit = {},
): Request {
  return new Request(`http://127.0.0.1:3000${path}`, init);
}

describe("gateway config", () => {
  test("fails closed without authentication configuration", () => {
    expect(() => loadGatewayConfig({})).toThrow("GATEWAY_API_TOKEN is required");
  });

  test("allows explicit unauthenticated local development", () => {
    const value = loadGatewayConfig({ GATEWAY_ALLOW_UNAUTHENTICATED: "1" });
    expect(value.allowUnauthenticated).toBe(true);
    expect(value.hostname).toBe("127.0.0.1");
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

describe("gateway policy boundary", () => {
  test("health is local gateway liveness and ends with a newline", async () => {
    const response = await handleRequest(request("/healthz"), {
      config,
      registry: TASK_REGISTRY,
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"status":"ok"');
    expect(body.endsWith("\n")).toBe(true);
  });

  test("protected task routes require bearer auth", async () => {
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
      { config, registry: TASK_REGISTRY, fetchImpl },
    );

    expect(response.status).toBe(401);
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
        headers: {
          authorization: "Bearer test-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "shell.exec", payload: { command: "id" } }),
      }),
      { config, registry: TASK_REGISTRY, fetchImpl },
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
        headers: {
          authorization: "Bearer test-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "document.process",
          kind: "gpu",
          payload: { id: "a" },
        }),
      }),
      { config, registry: TASK_REGISTRY, fetchImpl },
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("registered task is translated to the internal Rust contract", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const fetchImpl: FetchLike = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({ task_id: 7, status: "PENDING" }, { status: 202 });
    };

    const response = await handleRequest(
      request("/v1/tasks", {
        method: "POST",
        headers: {
          authorization: "Bearer test-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "document.process",
          payload: { document_id: "abc" },
          priority: 10,
          max_retries: 3,
        }),
      }),
      { config, registry: TASK_REGISTRY, fetchImpl },
    );

    expect(response.status).toBe(202);
    expect(capturedUrl).toBe("http://127.0.0.1:7331/v1/tasks");

    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("x-task-name")).toBe("document.process");
    expect(headers.get("x-task-type")).toBe("cpu");
    expect(headers.get("x-task-priority")).toBe("10");
    expect(headers.get("x-task-max-retries")).toBe("3");
    expect(capturedInit?.body).toBe('{"document_id":"abc"}');

    expect(await response.json()).toEqual({ task_id: 7, status: "PENDING" });
  });

  test("ready fails closed when the queue daemon is unavailable", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connection refused");
    };

    const response = await handleRequest(request("/readyz"), {
      config,
      registry: TASK_REGISTRY,
      fetchImpl,
    });

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
      { config, registry: TASK_REGISTRY, fetchImpl },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe(7);
    expect("payload" in body).toBe(false);
  });
});
