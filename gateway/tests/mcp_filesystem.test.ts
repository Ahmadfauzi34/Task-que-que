import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdmissionController } from "../src/admission";
import type { FetchLike, GatewayDependencies } from "../src/app";
import { issueCapabilitySession } from "../src/capability-auth";
import { CAPABILITY_AUTHORITY, CAPABILITY_DEPTH } from "../src/capabilities";
import type { GatewayConfig } from "../src/config";
import { handleMcpRequest, MCP_PROTOCOL_VERSION } from "../src/mcp";
import { TASK_REGISTRY } from "../src/registry";
import { routeGatewayRequest } from "../src/router";

const admissionController: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

async function rootFixture() {
  const root = await mkdtemp(join(tmpdir(), "tqq-mcp-fs-"));
  await writeFile(join(root, "proof.txt"), "mcp filesystem proof\n", "utf8");
  cleanupPaths.push(root);
  return root;
}

function providerSnapshot(): FetchLike {
  return async () => Response.json({
    schema_version: 1,
    active_task_names: [],
    worker_types: [],
  });
}

function dependencies(filesystemRoot: string | null): GatewayDependencies {
  const config: GatewayConfig = {
    hostname: "127.0.0.1",
    port: 3000,
    queueDaemonOrigin: "http://127.0.0.1:7331",
    workerBrokerOrigin: "http://127.0.0.1:7332",
    filesystemRoot,
    apiToken: "root-secret",
    allowUnauthenticated: false,
    upstreamTimeoutMs: 1_000,
    enqueueRatePerSecond: 10,
    enqueueBurst: 20,
    maxActiveTasks: 256,
  };
  return {
    config,
    registry: TASK_REGISTRY,
    admissionController,
    providerFetchImpl: providerSnapshot(),
  } as GatewayDependencies;
}

function meta() {
  return {
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": {
      name: "filesystem-proof",
      version: "1.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function request(
  method: string,
  params: Record<string, unknown>,
  token: string,
  name?: string,
): Request {
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    "mcp-method": method,
  });
  if (name) headers.set("mcp-name", name);
  return new Request("http://gateway.internal/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 43,
      method,
      params: { ...params, _meta: meta() },
    }),
  });
}

async function dispatch(
  mcpRequest: Request,
  deps: GatewayDependencies,
): Promise<Record<string, any>> {
  const response = await handleMcpRequest(
    mcpRequest,
    deps,
    (inner) => routeGatewayRequest(inner, deps),
  );
  if (!response) throw new Error("MCP request was not handled");
  return response.json() as Promise<Record<string, any>>;
}

async function session(scopes: string[]) {
  return issueCapabilitySession(
    "root-secret",
    {
      depth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
      authority: CAPABILITY_AUTHORITY.OBSERVE,
      scopes,
    },
    300,
  );
}

describe("MCP D5 filesystem provider", () => {
  test("advertises filesystem tools only when the server root exists and the signed grant permits them", async () => {
    const root = await rootFixture();
    const issued = await session(["filesystem.inspect", "filesystem.read"]);

    const enabled = await dispatch(
      request("tools/list", {}, issued.token),
      dependencies(root),
    );
    const names = enabled.result.tools.map((tool: Record<string, unknown>) => tool.name);
    expect(names).toContain("filesystem.list");
    expect(names).toContain("filesystem.stat");
    expect(names).toContain("filesystem.read");

    const disabled = await dispatch(
      request("tools/list", {}, issued.token),
      dependencies(null),
    );
    const disabledNames = disabled.result.tools.map(
      (tool: Record<string, unknown>) => tool.name,
    );
    expect(disabledNames).not.toContain("filesystem.list");
    expect(disabledNames).not.toContain("filesystem.stat");
    expect(disabledNames).not.toContain("filesystem.read");
  });

  test("reads through MCP without allowing the client to choose a filesystem root", async () => {
    const root = await rootFixture();
    const issued = await session(["filesystem.read"]);
    const deps = dependencies(root);

    const body = await dispatch(
      request(
        "tools/call",
        { name: "filesystem.read", arguments: { path: "proof.txt" } },
        issued.token,
        "filesystem.read",
      ),
      deps,
    );

    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent).toEqual({
      path: "proof.txt",
      encoding: "utf-8",
      bytes: 21,
      content: "mcp filesystem proof\n",
    });
    expect(JSON.stringify(body)).not.toContain(root);
  });

  test("withholds filesystem.read when only inspection scope was delegated", async () => {
    const root = await rootFixture();
    const issued = await session(["filesystem.inspect"]);
    const body = await dispatch(
      request("tools/list", {}, issued.token),
      dependencies(root),
    );
    const names = body.result.tools.map((tool: Record<string, unknown>) => tool.name);
    expect(names).toContain("filesystem.list");
    expect(names).toContain("filesystem.stat");
    expect(names).not.toContain("filesystem.read");
  });
});
