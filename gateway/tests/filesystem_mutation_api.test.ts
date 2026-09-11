import { describe, expect, test } from "bun:test";

import type { AdmissionController } from "../src/admission";
import type { GatewayDependencies } from "../src/app";
import { issueCapabilitySession } from "../src/capability-auth";
import { CAPABILITY_AUTHORITY, CAPABILITY_DEPTH } from "../src/capabilities";
import type { GatewayConfig } from "../src/config";
import type {
  FilesystemMutationCommand,
  FilesystemMutationRunner,
} from "../src/filesystem-mutation-api";
import { TASK_REGISTRY } from "../src/registry";
import { routeGatewayRequest } from "../src/router";

const admissionController: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

function dependencies(
  runner: FilesystemMutationRunner,
): GatewayDependencies {
  const config: GatewayConfig = {
    hostname: "127.0.0.1",
    port: 3000,
    queueDaemonOrigin: "http://127.0.0.1:7331",
    workerBrokerOrigin: "http://127.0.0.1:7332",
    filesystemRoot: "/delegated/proof-root",
    filesystemMutatorBin: "/opt/task-queue/robust-sinkhorn-fs-mutator",
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
    filesystemMutationRunImpl: runner,
  } as GatewayDependencies;
}

function request(
  path: string,
  token: string,
  body: Record<string, unknown>,
): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function session(
  authority: number,
  scopes: string[],
) {
  return issueCapabilitySession(
    "root-secret",
    {
      depth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
      authority: authority as typeof CAPABILITY_AUTHORITY.MUTATE_SCOPED,
      scopes,
    },
    300,
  );
}

describe("D5 Rust-backed filesystem mutation facade", () => {
  test("passes bounded write and mkdir operations to the server-owned Rust mutator", async () => {
    const commands: FilesystemMutationCommand[] = [];
    const runner: FilesystemMutationRunner = async (command) => {
      commands.push(command);
      return { ok: true };
    };
    const deps = dependencies(runner);
    const issued = await session(
      CAPABILITY_AUTHORITY.MUTATE_SCOPED,
      ["filesystem.write", "filesystem.mkdir"],
    );

    const write = await routeGatewayRequest(
      request(
        "/v1/filesystem/write",
        issued.token,
        { path: "src/proof.txt", content: "delegated mutation\n" },
      ),
      deps,
    );
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual({
      operation: "write",
      path: "src/proof.txt",
      committed: true,
      durability: "synced",
    });
    expect(commands[0]).toMatchObject({
      operation: "write",
      binary: "/opt/task-queue/robust-sinkhorn-fs-mutator",
      root: "/delegated/proof-root",
      path: "src/proof.txt",
    });
    expect(new TextDecoder().decode(commands[0]!.payload)).toBe("delegated mutation\n");

    const mkdir = await routeGatewayRequest(
      request("/v1/filesystem/mkdir", issued.token, { path: "src/new-dir" }),
      deps,
    );
    expect(mkdir.status).toBe(200);
    expect(commands[1]).toMatchObject({
      operation: "mkdir",
      path: "src/new-dir",
    });
  });

  test("denies mutation before the runner when authority is below A3", async () => {
    let calls = 0;
    const runner: FilesystemMutationRunner = async () => {
      calls += 1;
      return { ok: true };
    };
    const issued = await session(
      CAPABILITY_AUTHORITY.OBSERVE,
      ["filesystem.write"],
    );

    const response = await routeGatewayRequest(
      request(
        "/v1/filesystem/write",
        issued.token,
        { path: "proof.txt", content: "blocked" },
      ),
      dependencies(runner),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("filesystem.write denied by authority");
    expect(calls).toBe(0);
  });

  test("rejects normalized-away mutation paths before invoking Rust", async () => {
    let calls = 0;
    const runner: FilesystemMutationRunner = async () => {
      calls += 1;
      return { ok: true };
    };
    const issued = await session(
      CAPABILITY_AUTHORITY.MUTATE_SCOPED,
      ["filesystem.write"],
    );

    for (const path of ["a/../b", "a//b", "./a", "a/"]) {
      const response = await routeGatewayRequest(
        request(
          "/v1/filesystem/write",
          issued.token,
          { path, content: "blocked" },
        ),
        dependencies(runner),
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("invalid_path");
    }
    expect(calls).toBe(0);
  });

  test("preserves committed_durability_unknown as a non-retry-safe result", async () => {
    const runner: FilesystemMutationRunner = async () => ({
      ok: false,
      error: "committed_durability_unknown",
    });
    const issued = await session(
      CAPABILITY_AUTHORITY.MUTATE_SCOPED,
      ["filesystem.write"],
    );

    const response = await routeGatewayRequest(
      request(
        "/v1/filesystem/write",
        issued.token,
        { path: "proof.txt", content: "maybe durable" },
      ),
      dependencies(runner),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "filesystem_committed_durability_unknown",
        message: "filesystem mutation committed but durability could not be proven; do not retry blindly",
        committed: true,
        durability: "unknown",
        retry_safe: false,
      },
    });
  });
});
