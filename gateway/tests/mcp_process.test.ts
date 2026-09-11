import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdmissionController } from "../src/admission";
import type { FetchLike, GatewayDependencies } from "../src/app";
import { issueCapabilitySession } from "../src/capability-auth";
import { CAPABILITY_AUTHORITY, CAPABILITY_DEPTH } from "../src/capabilities";
import type { GatewayConfig } from "../src/config";
import {
  handleMcpRequestWithRegisteredProcesses,
  MCP_PROTOCOL_VERSION,
} from "../src/mcp-process";
import { TASK_REGISTRY } from "../src/registry";

const cleanup: string[] = [];
const admissionController: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

afterEach(async () => {
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

function providerSnapshot(): FetchLike {
  return async () => Response.json({
    schema_version: 1,
    active_task_names: [],
    worker_types: [],
  });
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "tqq-mcp-process-"));
  cleanup.push(base);
  const cwd = await realpath(base);
  const binary = await realpath(process.execPath);
  const registryPath = join(cwd, "registry.json");

  await writeFile(
    registryPath,
    `${JSON.stringify({
      version: 2,
      commands: [
        {
          name: "proof.read",
          binary,
          args: ["--version"],
          cwd,
          timeout_ms: 1_000,
          max_output_bytes: 16 * 1024,
          authority: "invoke",
          required_scope: "process.command.proof.read",
          mutates_state: false,
        },
        {
          name: "proof.mutate",
          binary,
          args: ["--version"],
          cwd,
          timeout_ms: 1_000,
          max_output_bytes: 16 * 1024,
          authority: "mutate_scoped",
          required_scope: "process.command.proof.mutate",
          mutates_state: true,
        },
      ],
    })}\n`,
    "utf8",
  );

  const config: GatewayConfig = {
    hostname: "127.0.0.1",
    port: 3000,
    queueDaemonOrigin: "http://127.0.0.1:7331",
    workerBrokerOrigin: "http://127.0.0.1:7332",
    processRegistryFile: registryPath,
    processExecBin: binary,
    apiToken: "root-secret",
    allowUnauthenticated: false,
    upstreamTimeoutMs: 1_000,
    enqueueRatePerSecond: 10,
    enqueueBurst: 20,
    maxActiveTasks: 256,
  };

  return {
    dependencies: {
      config,
      registry: TASK_REGISTRY,
      admissionController,
      providerFetchImpl: providerSnapshot(),
    } satisfies GatewayDependencies,
  };
}

function meta() {
  return {
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": {
      name: "registered-process-proof",
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
      id: 51,
      method,
      params: { ...params, _meta: meta() },
    }),
  });
}

async function session(authority: number, scopes: string[]) {
  return issueCapabilitySession(
    "root-secret",
    {
      depth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
      authority: authority as 0 | 1 | 2 | 3 | 4,
      scopes,
    },
    300,
  );
}

async function dispatch(
  mcpRequest: Request,
  dependencies: GatewayDependencies,
  invokeGateway: (request: Request) => Promise<Response> = async () =>
    Response.json({ ok: true }),
) {
  const response = await handleMcpRequestWithRegisteredProcesses(
    mcpRequest,
    dependencies,
    invokeGateway,
  );
  if (!response) throw new Error("MCP request was not handled");
  return response.json() as Promise<Record<string, any>>;
}

describe("MCP registered fixed operations", () => {
  test("advertises only live registered operations authorized by the signed grant", async () => {
    const { dependencies } = await fixture();
    const issued = await session(CAPABILITY_AUTHORITY.INVOKE, [
      "process.command.proof.read",
      "process.command.proof.mutate",
    ]);

    const body = await dispatch(request("tools/list", {}, issued.token), dependencies);
    const read = body.result.tools.find(
      (tool: Record<string, unknown>) => tool.name === "process.command.proof.read",
    );
    const mutate = body.result.tools.find(
      (tool: Record<string, unknown>) => tool.name === "process.command.proof.mutate",
    );

    expect(read).toMatchObject({
      name: "process.command.proof.read",
      inputSchema: { type: "object", additionalProperties: false },
      _meta: {
        "com.taskqueque/capability": {
          provider: "rust-process-exec",
          min_depth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
          min_authority: CAPABILITY_AUTHORITY.INVOKE,
          mutates_state: false,
        },
      },
    });
    expect(mutate).toBeUndefined();
  });

  test("advertises an A3 operation only to an exact scoped A3 session", async () => {
    const { dependencies } = await fixture();
    const issued = await session(CAPABILITY_AUTHORITY.MUTATE_SCOPED, [
      "process.command.proof.mutate",
    ]);

    const body = await dispatch(request("tools/list", {}, issued.token), dependencies);
    const names = body.result.tools.map((tool: Record<string, unknown>) => tool.name);
    expect(names).toContain("process.command.proof.mutate");
    expect(names).not.toContain("process.command.proof.read");
  });

  test("re-enters the fixed HTTP operation route instead of invoking the helper directly", async () => {
    const { dependencies } = await fixture();
    const issued = await session(CAPABILITY_AUTHORITY.INVOKE, [
      "process.command.proof.read",
    ]);
    const invocations: Request[] = [];

    const body = await dispatch(
      request(
        "tools/call",
        { name: "process.command.proof.read", arguments: {} },
        issued.token,
        "process.command.proof.read",
      ),
      dependencies,
      async (invocation) => {
        invocations.push(invocation);
        return Response.json({
          ok: true,
          exit_code: 0,
          stdout: "fd-bound proof",
          stderr: "",
        });
      },
    );

    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent).toMatchObject({
      ok: true,
      stdout: "fd-bound proof",
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.method).toBe("POST");
    expect(new URL(invocations[0]!.url).pathname).toBe("/v1/process/proof.read");
    expect(await invocations[0]!.text()).toBe("");
    expect(invocations[0]!.headers.get("authorization")).toBe(
      `Bearer ${issued.token}`,
    );
  });

  test("rejects caller arguments before the fixed HTTP operation is invoked", async () => {
    const { dependencies } = await fixture();
    const issued = await session(CAPABILITY_AUTHORITY.INVOKE, [
      "process.command.proof.read",
    ]);
    let calls = 0;

    const body = await dispatch(
      request(
        "tools/call",
        {
          name: "process.command.proof.read",
          arguments: { argv: "attacker" },
        },
        issued.token,
        "process.command.proof.read",
      ),
      dependencies,
      async () => {
        calls += 1;
        return Response.json({ ok: true });
      },
    );

    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain("advertised input schema");
    expect(calls).toBe(0);
  });

  test("withholds registered operations when the process provider is unavailable", async () => {
    const { dependencies } = await fixture();
    const issued = await session(CAPABILITY_AUTHORITY.INVOKE, [
      "process.command.proof.read",
    ]);
    const disabled: GatewayDependencies = {
      ...dependencies,
      config: {
        ...dependencies.config,
        processRegistryFile: null,
        processExecBin: null,
      },
    };

    const body = await dispatch(request("tools/list", {}, issued.token), disabled);
    const names = body.result.tools.map((tool: Record<string, unknown>) => tool.name);
    expect(names).not.toContain("process.command.proof.read");
  });
});
