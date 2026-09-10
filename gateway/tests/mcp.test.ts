import { describe, expect, test } from "bun:test";

import type { AdmissionController } from "../src/admission";
import type { FetchLike, GatewayDependencies } from "../src/app";
import { issueCapabilitySession } from "../src/capability-auth";
import { CAPABILITY_AUTHORITY, CAPABILITY_DEPTH } from "../src/capabilities";
import type { GatewayConfig } from "../src/config";
import { handleMcpRequest, MCP_PROTOCOL_VERSION } from "../src/mcp";
import { TASK_REGISTRY } from "../src/registry";
import { routeGatewayRequest } from "../src/router";

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

const admissionController: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

function dependencies(fetchImpl?: FetchLike): GatewayDependencies {
  return {
    config,
    registry: TASK_REGISTRY,
    admissionController,
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}

function paramsMeta(version = MCP_PROTOCOL_VERSION) {
  return {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": {
      name: "test-client",
      version: "1.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function mcpRequest(
  method: string,
  params: Record<string, unknown>,
  token = "test-secret",
  options: {
    version?: string;
    methodHeader?: string;
    nameHeader?: string;
    origin?: string;
  } = {},
): Request {
  const version = options.version ?? MCP_PROTOCOL_VERSION;
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": version,
    "mcp-method": options.methodHeader ?? method,
  });
  if (options.nameHeader !== undefined) headers.set("mcp-name", options.nameHeader);
  if (options.origin !== undefined) headers.set("origin", options.origin);
  return new Request("http://gateway.internal/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: params._meta ?? paramsMeta(version),
      },
    }),
  });
}

async function dispatch(request: Request, deps: GatewayDependencies): Promise<Response> {
  const response = await handleMcpRequest(
    request,
    deps,
    (inner) => routeGatewayRequest(inner, deps),
  );
  if (!response) throw new Error("MCP request was not handled");
  return response;
}

async function json(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>;
}

describe("MCP 2026-07-28 transport boundary", () => {
  test("implements stateless server/discover without initialize or MCP session ids", async () => {
    const response = await dispatch(mcpRequest("server/discover", {}), dependencies());
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();

    const body = await json(response);
    expect(body.result).toMatchObject({
      resultType: "complete",
      supportedVersions: [MCP_PROTOCOL_VERSION],
      capabilities: { tools: { listChanged: false } },
      cacheScope: "private",
    });
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"]).toMatchObject({
      name: "task-que-que",
      version: "0.2.0",
    });

    const legacy = await dispatch(mcpRequest("initialize", {}), dependencies());
    expect(legacy.status).toBe(404);
    expect((await json(legacy)).error.code).toBe(-32601);
  });

  test("fails closed when mirrored protocol, method, or tool name headers disagree", async () => {
    const wrongMethod = await dispatch(
      mcpRequest("tools/list", {}, "test-secret", { methodHeader: "server/discover" }),
      dependencies(),
    );
    expect(wrongMethod.status).toBe(400);
    expect((await json(wrongMethod)).error.code).toBe(-32020);

    const wrongName = await dispatch(
      mcpRequest(
        "tools/call",
        { name: "system.health", arguments: {} },
        "test-secret",
        { nameHeader: "system.readiness" },
      ),
      dependencies(),
    );
    expect(wrongName.status).toBe(400);
    expect((await json(wrongName)).error.code).toBe(-32020);

    const version = "2025-11-25";
    const unsupported = await dispatch(
      mcpRequest(
        "server/discover",
        { _meta: paramsMeta(version) },
        "test-secret",
        { version },
      ),
      dependencies(),
    );
    expect(unsupported.status).toBe(400);
    const unsupportedBody = await json(unsupported);
    expect(unsupportedBody.error.code).toBe(-32022);
    expect(unsupportedBody.error.data).toEqual({
      supported: [MCP_PROTOCOL_VERSION],
      requested: version,
    });
  });

  test("validates Origin when a browser-like caller supplies one", async () => {
    const response = await dispatch(
      mcpRequest("server/discover", {}, "test-secret", { origin: "https://attacker.example" }),
      dependencies(),
    );
    expect(response.status).toBe(403);
  });
});

describe("MCP capability projection", () => {
  test("lists only tools reachable through the signed session grant", async () => {
    const session = await issueCapabilitySession(
      "test-secret",
      {
        depth: CAPABILITY_DEPTH.EXECUTE,
        authority: CAPABILITY_AUTHORITY.INVOKE,
        scopes: ["capability.read", "task.invoke", "task:document.process"],
      },
      600,
    );

    const response = await dispatch(mcpRequest("tools/list", {}, session.token), dependencies());
    expect(response.status).toBe(200);
    const body = await json(response);
    const tools = body.result.tools as Array<Record<string, any>>;
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain("system.capabilities");
    expect(names).toContain("document.process");
    expect(names).toContain("task.submit");
    expect(names).not.toContain("hash.compute");
    expect(names).not.toContain("agent.invoke");
    expect(names).not.toContain("workflow.submit");

    const genericSubmit = tools.find((tool) => tool.name === "task.submit");
    expect(genericSubmit.inputSchema.properties.type.enum).toEqual(["document.process"]);
    expect(body.result.cacheScope).toBe("private");
  });

  test("keeps deeper locked capabilities visible through system.capabilities", async () => {
    const session = await issueCapabilitySession(
      "test-secret",
      {
        depth: CAPABILITY_DEPTH.DISCOVER,
        authority: CAPABILITY_AUTHORITY.OBSERVE,
        scopes: ["capability.read"],
      },
      600,
    );

    const response = await dispatch(
      mcpRequest(
        "tools/call",
        { name: "system.capabilities", arguments: {} },
        session.token,
        { nameHeader: "system.capabilities" },
      ),
      dependencies(),
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.result.isError).toBe(false);
    const remoteAgent = body.result.structuredContent.capabilities.find(
      (entry: Record<string, unknown>) => entry.name === "agent.invoke",
    );
    expect(remoteAgent.accessible).toBe(false);
    expect(remoteAgent.blocked_by).toEqual(["depth", "authority", "scope"]);
  });
});

describe("MCP tool calls reuse the proven gateway path", () => {
  test("invokes an exact registered task without laundering the session token into Rust", async () => {
    let rustAuthorization: string | null = "not-called";
    let rustTaskName: string | null = null;
    let rustTaskType: string | null = null;
    const fetchImpl: FetchLike = async (_input, init) => {
      const headers = new Headers(init?.headers);
      rustAuthorization = headers.get("authorization");
      rustTaskName = headers.get("x-task-name");
      rustTaskType = headers.get("x-task-type");
      return new Response(
        JSON.stringify({ task_id: 77, status: "PENDING", idempotency: "created" }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    };
    const deps = dependencies(fetchImpl);
    const session = await issueCapabilitySession(
      "test-secret",
      {
        depth: CAPABILITY_DEPTH.EXECUTE,
        authority: CAPABILITY_AUTHORITY.INVOKE,
        scopes: ["task.invoke", "task:document.process"],
      },
      600,
    );

    const response = await dispatch(
      mcpRequest(
        "tools/call",
        {
          name: "document.process",
          arguments: {
            payload: { document_id: "mcp-proof" },
            idempotency_key: "mcp-proof-1",
          },
        },
        session.token,
        { nameHeader: "document.process" },
      ),
      deps,
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent).toEqual({
      task_id: 77,
      status: "PENDING",
      replayed: false,
    });
    expect(rustTaskName).toBe("document.process");
    expect(rustTaskType).toBe("cpu");
    expect(rustAuthorization).toBeNull();
  });

  test("rejects an unavailable tool and malformed arguments before gateway I/O", async () => {
    let called = false;
    const deps = dependencies(async () => {
      called = true;
      return new Response();
    });
    const session = await issueCapabilitySession(
      "test-secret",
      {
        depth: CAPABILITY_DEPTH.EXECUTE,
        authority: CAPABILITY_AUTHORITY.INVOKE,
        scopes: ["task.invoke", "task:document.process"],
      },
      600,
    );

    const unavailable = await dispatch(
      mcpRequest(
        "tools/call",
        { name: "hash.compute", arguments: { payload: {}, idempotency_key: "nope" } },
        session.token,
        { nameHeader: "hash.compute" },
      ),
      deps,
    );
    expect((await json(unavailable)).error.code).toBe(-32602);

    const malformed = await dispatch(
      mcpRequest(
        "tools/call",
        { name: "document.process", arguments: { payload: {} } },
        session.token,
        { nameHeader: "document.process" },
      ),
      deps,
    );
    expect((await json(malformed)).error.code).toBe(-32602);
    expect(called).toBe(false);
  });

  test("returns sanitized gateway failures as MCP tool errors instead of protocol failures", async () => {
    const deps = dependencies(async () =>
      new Response(JSON.stringify({ error: { code: "queue_rejected_task", message: "queue daemon rejected the task" } }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
    );
    const session = await issueCapabilitySession(
      "test-secret",
      {
        depth: CAPABILITY_DEPTH.EXECUTE,
        authority: CAPABILITY_AUTHORITY.INVOKE,
        scopes: ["task.invoke", "task:document.process"],
      },
      600,
    );

    const response = await dispatch(
      mcpRequest(
        "tools/call",
        {
          name: "document.process",
          arguments: { payload: {}, idempotency_key: "mcp-fail-1" },
        },
        session.token,
        { nameHeader: "document.process" },
      ),
      deps,
    );
    const body = await json(response);
    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.error.code).toBe("queue_rejected_task");
  });
});
