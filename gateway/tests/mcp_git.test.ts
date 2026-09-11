import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdmissionController } from "../src/admission";
import type { FetchLike, GatewayDependencies } from "../src/app";
import { issueCapabilitySession } from "../src/capability-auth";
import { CAPABILITY_AUTHORITY, CAPABILITY_DEPTH } from "../src/capabilities";
import type { GatewayConfig } from "../src/config";
import type {
  GitMetadataCommand,
  GitMetadataRunner,
} from "../src/git-api";
import { handleMcpRequest, MCP_PROTOCOL_VERSION } from "../src/mcp";
import { TASK_REGISTRY } from "../src/registry";
import { routeGatewayRequest } from "../src/router";

const admissionController: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};
const cleanup: string[] = [];
const HEAD = "a".repeat(40);
const PARENT = "b".repeat(40);

function providerSnapshot(): FetchLike {
  return async () => Response.json({
    schema_version: 1,
    active_task_names: [],
    worker_types: [],
  });
}

afterEach(async () => {
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "tqq-mcp-git-"));
  cleanup.push(base);
  const repository = join(base, "repo");
  const binary = join(base, "git");
  await mkdir(join(repository, ".git"), { recursive: true });
  await writeFile(binary, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(binary, 0o700);
  return { repository, binary };
}

function dependencies(
  repository: string,
  binary: string,
  runner: GitMetadataRunner,
): GatewayDependencies {
  const config: GatewayConfig = {
    hostname: "127.0.0.1",
    port: 3000,
    queueDaemonOrigin: "http://127.0.0.1:7331",
    workerBrokerOrigin: "http://127.0.0.1:7332",
    filesystemRoot: null,
    filesystemMutatorBin: null,
    gitRepository: repository,
    gitBin: binary,
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
    gitMetadataRunImpl: runner,
  } as GatewayDependencies;
}

function meta() {
  return {
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": {
      name: "git-metadata-proof",
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
      id: 46,
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

async function gitSession(scopes: string[]) {
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

function liveRunner(
  repository: string,
  commands: GitMetadataCommand[] = [],
): GitMetadataRunner {
  return async (command) => {
    commands.push(command);
    switch (command.operation) {
      case "probe":
        return { ok: true, stdout: `${repository}\n` };
      case "head-sha":
        return { ok: true, stdout: `${HEAD}\n` };
      case "head-branch":
        return { ok: true, stdout: "main\n" };
      case "log":
        return { ok: true, stdout: `${HEAD}\t1700000000\t${PARENT}\n` };
      case "refs":
        return { ok: true, stdout: `refs/heads/main\t${HEAD}\tcommit\n` };
    }
  };
}

describe("MCP D5 Git metadata provider", () => {
  test("advertises metadata tools only for an authorized live provider", async () => {
    const { repository, binary } = await fixture();
    const issued = await gitSession(["git.inspect"]);
    const deps = dependencies(repository, binary, liveRunner(repository));

    const live = await dispatch(request("tools/list", {}, issued.token), deps);
    const names = live.result.tools.map((tool: Record<string, unknown>) => tool.name);
    expect(names).toContain("git.head");
    expect(names).toContain("git.log");
    expect(names).toContain("git.refs");

    const denied = await gitSession([]);
    const deniedBody = await dispatch(request("tools/list", {}, denied.token), deps);
    const deniedNames = deniedBody.result.tools.map(
      (tool: Record<string, unknown>) => tool.name,
    );
    expect(deniedNames).not.toContain("git.head");
    expect(deniedNames).not.toContain("git.log");
    expect(deniedNames).not.toContain("git.refs");
  });

  test("withholds metadata tools when provider probe fails", async () => {
    const { repository, binary } = await fixture();
    const issued = await gitSession(["git.inspect"]);
    const unavailable: GitMetadataRunner = async () => ({
      ok: false,
      error: "git_command_failed",
    });

    const body = await dispatch(
      request("tools/list", {}, issued.token),
      dependencies(repository, binary, unavailable),
    );
    const names = body.result.tools.map((tool: Record<string, unknown>) => tool.name);
    expect(names).not.toContain("git.head");
    expect(names).not.toContain("git.log");
    expect(names).not.toContain("git.refs");
  });

  test("routes git.head through the same signed gateway boundary with no caller arguments", async () => {
    const { repository, binary } = await fixture();
    const commands: GitMetadataCommand[] = [];
    const deps = dependencies(repository, binary, liveRunner(repository, commands));
    const issued = await gitSession(["git.inspect"]);

    const body = await dispatch(
      request(
        "tools/call",
        { name: "git.head", arguments: {} },
        issued.token,
        "git.head",
      ),
      deps,
    );

    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent).toEqual({
      head: HEAD,
      branch: "main",
      detached: false,
    });
    expect(commands[0]?.operation).toBe("probe");
    expect(
      commands.slice(1).map((command) => command.operation).sort(),
    ).toEqual(["head-branch", "head-sha"]);
  });

  test("rejects caller-selected Git arguments before invocation", async () => {
    const { repository, binary } = await fixture();
    const commands: GitMetadataCommand[] = [];
    const deps = dependencies(repository, binary, liveRunner(repository, commands));
    const issued = await gitSession(["git.inspect"]);

    const body = await dispatch(
      request(
        "tools/call",
        { name: "git.log", arguments: { ref: "HEAD~1" } },
        issued.token,
        "git.log",
      ),
      deps,
    );

    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain("advertised input schema");
    expect(commands.map((command) => command.operation)).toEqual(["probe"]);
  });
});
