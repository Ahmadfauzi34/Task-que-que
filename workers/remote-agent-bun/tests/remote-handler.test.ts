import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_REMOTE_INPUT_BYTES,
  MAX_REMOTE_RESPONSE_BYTES,
  RemoteAgentPayloadError,
  createRemoteAgentHandler,
  invokeRemoteAgent,
  normalizeRemoteEndpoint,
  parseRemoteAgentInvocation,
  writeRemoteAgentResultAtomic,
} from "../src/remote-handler";
import {
  createRemoteAgentWorkerRegistry,
  loadRemoteAgentWorkerConfig,
} from "../src/worker";

const servers: Bun.Server<unknown>[] = [];
const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("remote agent endpoint boundary", () => {
  test("accepts https remote endpoints and http loopback only", () => {
    expect(normalizeRemoteEndpoint("https://agent.example/v1/invoke")).toBe(
      "https://agent.example/v1/invoke",
    );
    expect(normalizeRemoteEndpoint("http://127.0.0.1:7440/invoke")).toBe(
      "http://127.0.0.1:7440/invoke",
    );
    expect(() => normalizeRemoteEndpoint("http://agent.example/invoke")).toThrow();
    expect(() => normalizeRemoteEndpoint("ftp://agent.example/invoke")).toThrow();
    expect(() => normalizeRemoteEndpoint("https://user:pass@agent.example/invoke")).toThrow();
    expect(() => normalizeRemoteEndpoint("https://agent.example/invoke?next=x")).toThrow();
    expect(() => normalizeRemoteEndpoint("https://agent.example/invoke#fragment")).toThrow();
  });

  test("keeps endpoint, method, headers, and command outside task control", () => {
    for (const key of ["url", "endpoint", "method", "headers", "command"]) {
      expect(() =>
        parseRemoteAgentInvocation(JSON.stringify({ input: { prompt: "hello" }, [key]: "x" })),
      ).toThrow(RemoteAgentPayloadError);
    }
  });
});

describe("remote agent invocation", () => {
  test("sends a fixed bounded envelope with auth and deterministic idempotency", async () => {
    let observed: Record<string, unknown> | undefined;
    let authorization: string | null = null;
    let idempotency: string | null = null;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        authorization = request.headers.get("authorization");
        idempotency = request.headers.get("idempotency-key");
        observed = (await request.json()) as Record<string, unknown>;
        return Response.json({
          result: { answer: "accepted" },
          meta: { engine: "mock-agent" },
        });
      },
    });
    servers.push(server);

    const endpoint = `http://127.0.0.1:${server.port}/invoke`;
    const result = await invokeRemoteAgent(
      42,
      JSON.stringify({ input: { prompt: "hello" }, request_id: "req-42" }),
      {
        endpoint,
        providerId: "mock-provider",
        bearerToken: "secret-token",
        timeoutMs: 2_000,
      },
    );

    expect(observed).toEqual({
      schema_version: 1,
      task_id: 42,
      request_id: "req-42",
      input: { prompt: "hello" },
    });
    expect(authorization).toBe("Bearer secret-token");
    expect(idempotency).toBe("task-queue-42");
    expect(result).toEqual({
      schema_version: 1,
      task_id: 42,
      provider_id: "mock-provider",
      request_id: "req-42",
      result: { answer: "accepted" },
      meta: { engine: "mock-agent" },
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain(endpoint);
  });

  test("does not follow remote redirects", async () => {
    let redirectedCalls = 0;
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        redirectedCalls += 1;
        return Response.json({ result: "should-not-run" });
      },
    });
    servers.push(target);

    const redirector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { Location: `http://127.0.0.1:${target.port}/invoke` },
        });
      },
    });
    servers.push(redirector);

    await expect(
      invokeRemoteAgent(7, JSON.stringify({ input: "x" }), {
        endpoint: `http://127.0.0.1:${redirector.port}/invoke`,
        providerId: "redirect-test",
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow();
    expect(redirectedCalls).toBe(0);
  });

  test("rejects oversized remote responses before persisting them", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ result: "x".repeat(MAX_REMOTE_RESPONSE_BYTES + 1024) });
      },
    });
    servers.push(server);

    await expect(
      invokeRemoteAgent(9, JSON.stringify({ input: "x" }), {
        endpoint: `http://127.0.0.1:${server.port}/invoke`,
        providerId: "oversize-test",
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow("exceeds 256 KiB");
  });

  test("writes a deterministic atomic result file and can overwrite on retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "remote-agent-test-"));
    cleanupPaths.push(dir);
    const result = {
      schema_version: 1 as const,
      task_id: 11,
      provider_id: "mock-provider",
      result: { ok: true },
    };

    const first = await writeRemoteAgentResultAtomic(dir, result);
    const second = await writeRemoteAgentResultAtomic(dir, result);
    expect(first).toBe(second);
    expect(JSON.parse(await readFile(first, "utf8"))).toEqual(result);
  });

  test("fails closed on missing input, unknown fields, unsafe request ids, and oversized payloads", () => {
    expect(() => parseRemoteAgentInvocation("{}"))
      .toThrow(RemoteAgentPayloadError);
    expect(() => parseRemoteAgentInvocation('{"input":1,"url":"https://evil.example"}'))
      .toThrow(RemoteAgentPayloadError);
    expect(() => parseRemoteAgentInvocation('{"input":1,"request_id":"bad id"}'))
      .toThrow(RemoteAgentPayloadError);

    const large = JSON.stringify({ input: "x".repeat(MAX_REMOTE_INPUT_BYTES + 1) });
    expect(() => parseRemoteAgentInvocation(large)).toThrow(RemoteAgentPayloadError);
  });
});

describe("remote agent worker capability", () => {
  test("declares a dedicated hard capability", () => {
    const config = {
      endpoint: "http://127.0.0.1:7440/invoke",
      providerId: "reference-agent",
      timeoutMs: 5_000,
    };
    const handler = createRemoteAgentHandler(config);
    const registry = createRemoteAgentWorkerRegistry(config);

    expect(handler.taskName).toBe("agent.invoke");
    expect(handler.taskType).toBe("remote-agent");
    expect(registry.workerType).toBe("remote-agent");
    expect(registry.resolve("agent.invoke", "remote-agent")).toBeDefined();
    expect(registry.resolve("agent.invoke", "cpu")).toBeUndefined();
  });

  test("keeps remote endpoint and bearer token in worker configuration", () => {
    const config = loadRemoteAgentWorkerConfig({
      REMOTE_AGENT_ENDPOINT: "https://agent.example/v1/invoke",
      REMOTE_AGENT_PROVIDER_ID: "provider-a",
      REMOTE_AGENT_BEARER_TOKEN: "worker-secret",
      REMOTE_AGENT_OUTPUT_DIR: "/tmp/remote-agent-results",
    });

    expect(config.remote.endpoint).toBe("https://agent.example/v1/invoke");
    expect(config.remote.providerId).toBe("provider-a");
    expect(config.remote.bearerToken).toBe("worker-secret");
    expect(config.outputDir).toBe("/tmp/remote-agent-results");
  });
});
