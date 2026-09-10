import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdmissionController } from "../src/admission";
import type { GatewayDependencies } from "../src/app";
import { issueCapabilitySession } from "../src/capability-auth";
import { CAPABILITY_AUTHORITY, CAPABILITY_DEPTH } from "../src/capabilities";
import type { GatewayConfig } from "../src/config";
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

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "tqq-fs-proof-"));
  const root = join(base, "delegated");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "README.md"), "delegated proof\n", "utf8");
  await writeFile(join(root, "src", "index.ts"), "export const ok = true;\n", "utf8");
  await writeFile(join(outside, "secret.txt"), "must stay outside\n", "utf8");
  await symlink(join(outside, "secret.txt"), join(root, "escape-link"));
  cleanupPaths.push(base);
  return { root };
}

function config(filesystemRoot: string | null): GatewayConfig {
  return {
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
}

function dependencies(filesystemRoot: string | null): GatewayDependencies {
  return {
    config: config(filesystemRoot),
    registry: TASK_REGISTRY,
    admissionController,
  };
}

function request(path: string, token: string, relativePath: string): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ path: relativePath }),
  });
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

describe("D5 scoped read-only filesystem provider", () => {
  test("lists, stats, and reads inside the configured root with exact session scopes", async () => {
    const { root } = await fixture();
    const issued = await session(["filesystem.inspect", "filesystem.read"]);
    const deps = dependencies(root);

    const list = await routeGatewayRequest(
      request("/v1/filesystem/list", issued.token, "."),
      deps,
    );
    expect(list.status).toBe(200);
    const listBody = await list.json() as Record<string, any>;
    expect(listBody.path).toBe(".");
    expect(listBody.entries.map((entry: Record<string, unknown>) => entry.name)).toEqual([
      "escape-link",
      "README.md",
      "src",
    ]);
    expect(JSON.stringify(listBody)).not.toContain(root);

    const stat = await routeGatewayRequest(
      request("/v1/filesystem/stat", issued.token, "src/index.ts"),
      deps,
    );
    expect(stat.status).toBe(200);
    expect(await stat.json()).toMatchObject({
      path: "src/index.ts",
      type: "file",
    });

    const read = await routeGatewayRequest(
      request("/v1/filesystem/read", issued.token, "README.md"),
      deps,
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      path: "README.md",
      encoding: "utf-8",
      bytes: 16,
      content: "delegated proof\n",
    });
  });

  test("denies read before filesystem I/O when the signed session lacks filesystem.read", async () => {
    const { root } = await fixture();
    const issued = await session(["filesystem.inspect"]);

    const response = await routeGatewayRequest(
      request("/v1/filesystem/read", issued.token, "README.md"),
      dependencies(root),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("filesystem.read denied by scope");
  });

  test("rejects parent traversal, absolute paths, and symlink escape", async () => {
    const { root } = await fixture();
    const issued = await session(["filesystem.inspect", "filesystem.read"]);
    const deps = dependencies(root);

    const parent = await routeGatewayRequest(
      request("/v1/filesystem/read", issued.token, "../outside/secret.txt"),
      deps,
    );
    expect(parent.status).toBe(403);
    expect(await parent.text()).toContain("filesystem_escape");

    const absolute = await routeGatewayRequest(
      request("/v1/filesystem/read", issued.token, "/etc/passwd"),
      deps,
    );
    expect(absolute.status).toBe(400);
    expect(await absolute.text()).toContain("invalid_path");

    const symlinkEscape = await routeGatewayRequest(
      request("/v1/filesystem/read", issued.token, "escape-link"),
      deps,
    );
    expect(symlinkEscape.status).toBe(403);
    expect(await symlinkEscape.text()).toContain("filesystem_escape");
  });

  test("rejects a configured root that canonicalizes to the host filesystem root", async () => {
    const base = await mkdtemp(join(tmpdir(), "tqq-fs-root-alias-"));
    const rootAlias = join(base, "root-link");
    await symlink("/", rootAlias);
    cleanupPaths.push(base);

    const response = await routeGatewayRequest(
      request("/v1/filesystem/list", "root-secret", "."),
      dependencies(rootAlias),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("filesystem_unavailable");
  });

  test("fails closed when the filesystem provider is not configured", async () => {
    const response = await routeGatewayRequest(
      request("/v1/filesystem/list", "root-secret", "."),
      dependencies(null),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("filesystem_unavailable");
  });
});
