import { describe, expect, test } from "bun:test";

import type { AdmissionController } from "../src/admission";
import type { FetchLike, GatewayDependencies } from "../src/app";
import { issueCapabilitySession } from "../src/capability-auth";
import { CAPABILITY_AUTHORITY, CAPABILITY_DEPTH } from "../src/capabilities";
import type { GatewayConfig } from "../src/config";
import type {
  FilesystemMutationCommand,
  FilesystemMutationRunner,
} from "../src/filesystem-mutation-api";
import { handleMcpRequest, MCP_PROTOCOL_VERSION } from "../src/mcp";
import { TASK_REGISTRY } from "../src/registry";
import { routeGatewayRequest } from "../src/router";

const admissionController: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

function providerSnapshot(): FetchLike {
  return async () => Response.json({
    schema_version: 1,
    active_task_names: [],
    worker_types: [],
  });
}

function dependencies(
  runner: FilesystemMutationRunner,
  mutatorConfigured = true,
): GatewayDependencies {
  const config: GatewayConfig = {
    hostname: "127.0.0.1",
    port: 3000,
    queueDaemonOrigin: "http://127.0.0.1:7331",
    workerBrokerOrigin: "http://127.0.0.1:7332",
    filesystemRoot: "/delegated/proof-root",
    filesystemMutatorBin: mutatorConfigured
      ? "/opt/task-queue/robust-sinkhorn-fs-mutator"
      : null,
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
    filesystemMutationRunImpl: runner,
  } as GatewayDependencies;
}

function meta() {
  return {
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": {
      name: "filesystem-mutation-proof",
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
      id: 45,
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

async function mutationSession(scopes: string[]) {
  return issueCapabilitySession(
    "root-secret",
    {
      depth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
      authority: CAPABILITY_AUTHORITY.MUTATE_SCOPED,
      scopes,
    },
    300,
  );
}

describe("MCP D5 filesystem mutation provider", () => {
  test("advertises write and mkdir only when the Rust mutator probe succeeds", async () => {
    const liveRunner: FilesystemMutationRunner = async (command) => ({
      ok: command.operation === "probe",
    });
    const issued = await mutationSession(["filesystem.write", "filesystem.mkdir"]);

    const live = await dispatch(
      request("tools/list", {}, issued.token),
      dependencies(liveRunner),
    );
    const liveNames = live.result.tools.map((tool: Record<string, unknown>) => tool.name);
    expect(liveNames).toContain("filesystem.write");
    expect(liveNames).toContain("filesystem.mkdir");

    const unavailableRunner: FilesystemMutationRunner = async () => ({
      ok: false,
      error: "mutation_process_unavailable",
    });
    const unavailable = await dispatch(
      request("tools/list", {}, issued.token),
      dependencies(unavailableRunner),
    );
    const unavailableNames = unavailable.result.tools.map(
      (tool: Record<string, unknown>) => tool.name,
    );
    expect(unavailableNames).not.toContain("filesystem.write");
    expect(unavailableNames).not.toContain("filesystem.mkdir");
  });

  test("routes filesystem.write through the same signed gateway boundary and Rust runner", async () => {
    const commands: FilesystemMutationCommand[] = [];
    const runner: FilesystemMutationRunner = async (command) => {
      commands.push(command);
      return { ok: true };
    };
    const issued = await mutationSession(["filesystem.write"]);
    const deps = dependencies(runner);

    const body = await dispatch(
      request(
        "tools/call",
        {
          name: "filesystem.write",
          arguments: { path: "notes/proof.txt", content: "MCP mutation\n" },
        },
        issued.token,
        "filesystem.write",
      ),
      deps,
    );

    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent).toEqual({
      operation: "write",
      path: "notes/proof.txt",
      committed: true,
      durability: "synced",
    });
    expect(commands.map((command) => command.operation)).toEqual(["probe", "write"]);
    expect(new TextDecoder().decode(commands[1]!.payload)).toBe("MCP mutation\n");
  });

  test("withholds mutation tools from an A0 session even when scopes are present", async () => {
    const runner: FilesystemMutationRunner = async () => ({ ok: true });
    const issued = await issueCapabilitySession(
      "root-secret",
      {
        depth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
        authority: CAPABILITY_AUTHORITY.OBSERVE,
        scopes: ["filesystem.write", "filesystem.mkdir"],
      },
      300,
    );

    const body = await dispatch(
      request("tools/list", {}, issued.token),
      dependencies(runner),
    );
    const names = body.result.tools.map((tool: Record<string, unknown>) => tool.name);
    expect(names).not.toContain("filesystem.write");
    expect(names).not.toContain("filesystem.mkdir");
  });
});
