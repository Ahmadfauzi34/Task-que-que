import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdmissionController } from "../src/admission";
import type { GatewayDependencies } from "../src/app";
import type { AuthorizationContext } from "../src/capability-auth";
import { handleCapabilityRequest } from "../src/capability-api";
import {
  CAPABILITY_AUTHORITY,
  CAPABILITY_DEPTH,
} from "../src/capabilities";
import type { GatewayConfig } from "../src/config";
import {
  handleRegisteredProcessRequest,
  type RegisteredProcessRunner,
} from "../src/process-api";
import { TASK_REGISTRY } from "../src/registry";

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

const admissionController: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "tqq-process-api-"));
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
    apiToken: "test-secret",
    allowUnauthenticated: false,
    upstreamTimeoutMs: 1_000,
    enqueueRatePerSecond: 10,
    enqueueBurst: 20,
    maxActiveTasks: 256,
  };
  const dependencies: GatewayDependencies = {
    config,
    registry: TASK_REGISTRY,
    admissionController,
  };

  return { base, cwd, binary, registryPath, dependencies };
}

function auth(
  authority: number,
  scopes: readonly string[],
): AuthorizationContext {
  return {
    kind: "session",
    grant: {
      depth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
      authority: authority as 0 | 1 | 2 | 3 | 4,
      scopes,
    },
    sessionId: "proof-session",
    expiresAt: Date.now() + 60_000,
  };
}

describe("registered process agent boundary", () => {
  test("projects live fixed commands without provider paths or argv", async () => {
    const { dependencies, binary, cwd } = await fixture();
    const response = await handleCapabilityRequest(
      new Request("http://127.0.0.1:3000/v1/capabilities"),
      dependencies,
      auth(CAPABILITY_AUTHORITY.INVOKE, [
        "capability.read",
        "process.command.proof.read",
      ]),
    );

    expect(response?.status).toBe(200);
    const body = (await response!.json()) as Record<string, any>;
    expect(body.runtime.registered_process_reachable).toBe(true);

    const read = body.capabilities.find(
      (entry: Record<string, unknown>) => entry.name === "process.command.proof.read",
    );
    expect(read).toMatchObject({
      provider: "rust-process-exec",
      min_depth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
      min_authority: CAPABILITY_AUTHORITY.INVOKE,
      required_scopes: ["process.command.proof.read"],
      authorized: true,
      available: true,
      executable: true,
      route: "/v1/process/proof.read",
      method: "POST",
    });

    const mutate = body.capabilities.find(
      (entry: Record<string, unknown>) => entry.name === "process.command.proof.mutate",
    );
    expect(mutate).toMatchObject({
      min_authority: CAPABILITY_AUTHORITY.MUTATE_SCOPED,
      authorized: false,
      available: true,
      executable: false,
    });

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(binary);
    expect(serialized).not.toContain(cwd);
    expect(serialized).not.toContain("--version");
  });

  test("accepts no caller arguments and rejects A1 before an A3 command reaches the runner", async () => {
    const { dependencies } = await fixture();
    let calls = 0;
    const runner: RegisteredProcessRunner = async (_registry, name) => {
      calls += 1;
      return { ok: true, exit_code: 0, stdout: `ran=${name}`, stderr: "" };
    };

    const readResponse = await handleRegisteredProcessRequest(
      new Request("http://127.0.0.1:3000/v1/process/proof.read", { method: "POST" }),
      dependencies,
      undefined,
      auth(CAPABILITY_AUTHORITY.INVOKE, ["process.command.proof.read"]),
      runner,
    );
    expect(readResponse?.status).toBe(200);
    expect(await readResponse!.json()).toMatchObject({
      ok: true,
      exit_code: 0,
      stdout: "ran=proof.read",
    });
    expect(calls).toBe(1);

    const denied = await handleRegisteredProcessRequest(
      new Request("http://127.0.0.1:3000/v1/process/proof.mutate", { method: "POST" }),
      dependencies,
      undefined,
      auth(CAPABILITY_AUTHORITY.INVOKE, ["process.command.proof.mutate"]),
      runner,
    );
    expect(denied?.status).toBe(403);
    expect(calls).toBe(1);

    const query = await handleRegisteredProcessRequest(
      new Request("http://127.0.0.1:3000/v1/process/proof.read?argv=attacker", { method: "POST" }),
      dependencies,
      undefined,
      auth(CAPABILITY_AUTHORITY.INVOKE, ["process.command.proof.read"]),
      runner,
    );
    expect(query?.status).toBe(400);
    expect(calls).toBe(1);

    const body = await handleRegisteredProcessRequest(
      new Request("http://127.0.0.1:3000/v1/process/proof.read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      dependencies,
      undefined,
      auth(CAPABILITY_AUTHORITY.INVOKE, ["process.command.proof.read"]),
      runner,
    );
    expect(body?.status).toBe(400);
    expect(calls).toBe(1);
  });

  test("fails closed when the process provider is not configured", async () => {
    const { dependencies } = await fixture();
    const disabled = {
      ...dependencies,
      config: {
        ...dependencies.config,
        processRegistryFile: null,
        processExecBin: null,
      },
    } satisfies GatewayDependencies;

    const response = await handleRegisteredProcessRequest(
      new Request("http://127.0.0.1:3000/v1/process/proof.read", { method: "POST" }),
      disabled,
      undefined,
      auth(CAPABILITY_AUTHORITY.INVOKE, ["process.command.proof.read"]),
    );
    expect(response?.status).toBe(503);
  });
});
