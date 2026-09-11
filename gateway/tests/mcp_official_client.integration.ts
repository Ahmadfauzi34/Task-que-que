import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const cleanupPaths: string[] = [];
let serverProcess: ReturnType<typeof Bun.spawn> | null = null;
let client: Client | null = null;

afterEach(async () => {
  if (client) {
    try {
      await client.close();
    } catch {
      // Best-effort cleanup only.
    }
    client = null;
  }

  if (serverProcess) {
    try {
      serverProcess.kill();
      await serverProcess.exited;
    } catch {
      // Best-effort cleanup only.
    }
    serverProcess = null;
  }

  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

async function waitForHealth(origin: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (serverProcess && await serverProcess.exited.then(() => true, () => false)) {
      throw new Error("gateway exited before becoming healthy");
    }

    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await Bun.sleep(50);
  }
  throw new Error("gateway did not become healthy");
}

async function mintSession(origin: string, rootToken: string): Promise<string> {
  const response = await fetch(`${origin}/v1/capability-sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${rootToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      depth: 5,
      authority: 1,
      scopes: ["process.command.proof.read"],
      ttl_seconds: 300,
    }),
  });

  if (!response.ok) {
    throw new Error(`capability session issuance failed: HTTP ${response.status}`);
  }

  const body = await response.json() as { session_token?: unknown };
  if (typeof body.session_token !== "string" || body.session_token.length === 0) {
    throw new Error("capability session response did not contain a token");
  }
  return body.session_token;
}

describe("official MCP 2026-07-28 client interoperability", () => {
  test("connects, discovers, lists and calls a scoped registered operation through the real gateway", async () => {
    const configuredHelper = process.env.TASK_QUEUE_PROCESS_EXEC_BIN;
    if (!configuredHelper) {
      throw new Error("TASK_QUEUE_PROCESS_EXEC_BIN is required");
    }
    const helper = await realpath(configuredHelper);

    const base = await mkdtemp(join(tmpdir(), "tqq-mcp-official-client-"));
    cleanupPaths.push(base);
    const cwd = await realpath(base);
    const registryPath = join(base, "process-registry.json");
    const rootToken = "official-mcp-v2-client-proof-root";
    const port = 3217;
    const origin = `http://127.0.0.1:${port}`;

    await writeFile(
      registryPath,
      `${JSON.stringify({
        version: 2,
        commands: [
          {
            name: "proof.read",
            binary: helper,
            args: ["--self-proof-child", "official-mcp-v2-client"],
            cwd,
            timeout_ms: 2_000,
            max_output_bytes: 16 * 1024,
            authority: "invoke",
            required_scope: "process.command.proof.read",
            mutates_state: false,
          },
        ],
      })}\n`,
      "utf8",
    );

    serverProcess = Bun.spawn(
      [process.execPath, "run", "src/server.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GATEWAY_HOST: "127.0.0.1",
          GATEWAY_PORT: String(port),
          QUEUE_DAEMON_URL: "http://127.0.0.1:7491",
          WORKER_BROKER_URL: "http://127.0.0.1:7492",
          GATEWAY_UPSTREAM_TIMEOUT_MS: "500",
          GATEWAY_API_TOKEN: rootToken,
          GATEWAY_PROCESS_REGISTRY_FILE: registryPath,
          GATEWAY_PROCESS_EXEC_BIN: helper,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    await waitForHealth(origin);
    const sessionToken = await mintSession(origin, rootToken);

    const transport = new StreamableHTTPClientTransport(
      new URL(`${origin}/mcp`),
      {
        authProvider: {
          token: async () => sessionToken,
        },
      },
    );

    client = new Client(
      {
        name: "task-que-que-official-client-proof",
        version: "1.0.0",
      },
      {
        versionNegotiation: { mode: "auto" },
      },
    );

    await client.connect(transport);
    expect(client.getProtocolEra()).toBe("modern");

    const listed = await client.listTools();
    const processTool = listed.tools.find(
      (tool) => tool.name === "process.command.proof.read",
    );
    expect(processTool).toBeDefined();
    expect(processTool?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });

    const result = await client.callTool({
      name: "process.command.proof.read",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      exit_code: 0,
    });

    const structured = result.structuredContent as { stdout?: unknown };
    expect(typeof structured.stdout).toBe("string");
    expect(structured.stdout).toContain("fd_bound_child=OK");
    expect(structured.stdout).toContain("marker=official-mcp-v2-client");
    expect(structured.stdout).toContain(`cwd=${cwd}`);
  }, 20_000);
});
