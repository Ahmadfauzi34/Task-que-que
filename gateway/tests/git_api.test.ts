import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdmissionController } from "../src/admission";
import type { GatewayDependencies } from "../src/app";
import { issueCapabilitySession } from "../src/capability-auth";
import { CAPABILITY_AUTHORITY, CAPABILITY_DEPTH } from "../src/capabilities";
import type { GatewayConfig } from "../src/config";
import {
  gitMetadataAvailable,
  type GitMetadataCommand,
  type GitMetadataRunner,
} from "../src/git-api";
import { TASK_REGISTRY } from "../src/registry";
import { routeGatewayRequest } from "../src/router";

const cleanup: string[] = [];
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

const admissionController: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

afterEach(async () => {
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "tqq-git-api-"));
  cleanup.push(base);
  const repository = join(base, "repo");
  const binary = join(base, "git");
  await mkdir(join(repository, ".git"), { recursive: true });
  await writeFile(binary, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(binary, 0o700);
  return { base, repository, binary };
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
    gitMetadataRunImpl: runner,
  } as GatewayDependencies;
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

function request(path: string, token: string): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

function successfulRunner(commands: GitMetadataCommand[]): GitMetadataRunner {
  return async (command) => {
    commands.push(command);
    switch (command.operation) {
      case "probe":
        return { ok: true, stdout: `${command.repository}\n` };
      case "head-sha":
        return { ok: true, stdout: `${SHA_A}\n` };
      case "head-branch":
        return { ok: true, stdout: "main\n" };
      case "log":
        return {
          ok: true,
          stdout: `${SHA_A}\t1700000000\t${SHA_B} ${SHA_C}\n${SHA_B}\t1699999999\t\n`,
        };
      case "refs":
        return {
          ok: true,
          stdout: `refs/heads/main\t${SHA_A}\tcommit\nrefs/tags/v1\t${SHA_C}\ttag\n`,
        };
    }
  };
}

describe("D5 Git metadata provider", () => {
  test("requires exact git.inspect scope before provider execution", async () => {
    const { repository, binary } = await fixture();
    let calls = 0;
    const runner: GitMetadataRunner = async () => {
      calls += 1;
      return { ok: true, stdout: `${SHA_A}\n` };
    };
    const issued = await session([]);

    const response = await routeGatewayRequest(
      request("/v1/git/head", issued.token),
      dependencies(repository, binary, runner),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("git.head denied by scope");
    expect(calls).toBe(0);
  });

  test("projects bounded head, log and refs without exposing provider paths", async () => {
    const { repository, binary } = await fixture();
    const commands: GitMetadataCommand[] = [];
    const deps = dependencies(repository, binary, successfulRunner(commands));
    const issued = await session(["git.inspect"]);

    const head = await routeGatewayRequest(request("/v1/git/head", issued.token), deps);
    expect(head.status).toBe(200);
    expect(await head.json()).toEqual({
      head: SHA_A,
      branch: "main",
      detached: false,
    });

    const log = await routeGatewayRequest(request("/v1/git/log", issued.token), deps);
    expect(log.status).toBe(200);
    expect(await log.json()).toEqual({
      commits: [
        { id: SHA_A, unix_time: 1700000000, parents: [SHA_B, SHA_C] },
        { id: SHA_B, unix_time: 1699999999, parents: [] },
      ],
    });

    const refs = await routeGatewayRequest(request("/v1/git/refs", issued.token), deps);
    expect(refs.status).toBe(200);
    expect(await refs.json()).toEqual({
      refs: [
        { name: "refs/heads/main", target: SHA_A, object_type: "commit" },
        { name: "refs/tags/v1", target: SHA_C, object_type: "tag" },
      ],
    });

    const serialized = JSON.stringify([
      await (await routeGatewayRequest(request("/v1/git/head", issued.token), deps)).json(),
      await (await routeGatewayRequest(request("/v1/git/log", issued.token), deps)).json(),
      await (await routeGatewayRequest(request("/v1/git/refs", issued.token), deps)).json(),
    ]);
    expect(serialized).not.toContain(repository);
    expect(serialized).not.toContain(binary);
    expect(commands.some((command) => command.operation === "head-sha")).toBe(true);
    expect(commands.some((command) => command.operation === "log")).toBe(true);
    expect(commands.some((command) => command.operation === "refs")).toBe(true);
  });

  test("availability requires non-symlink server-owned repository and binary identities", async () => {
    const { base, repository, binary } = await fixture();
    let calls = 0;
    const runner: GitMetadataRunner = async (command) => {
      calls += 1;
      return { ok: true, stdout: `${command.repository}\n` };
    };

    expect(await gitMetadataAvailable(dependencies(repository, binary, runner))).toBe(true);
    expect(calls).toBe(1);

    const repositoryLink = join(base, "repo-link");
    await symlink(repository, repositoryLink);
    calls = 0;
    expect(await gitMetadataAvailable(dependencies(repositoryLink, binary, runner))).toBe(false);
    expect(calls).toBe(0);

    const binaryLink = join(base, "git-link");
    await symlink(binary, binaryLink);
    calls = 0;
    expect(await gitMetadataAvailable(dependencies(repository, binaryLink, runner))).toBe(false);
    expect(calls).toBe(0);
  });

  test("rejects query parameters before provider execution", async () => {
    const { repository, binary } = await fixture();
    let calls = 0;
    const runner: GitMetadataRunner = async () => {
      calls += 1;
      return { ok: true, stdout: `${SHA_A}\n` };
    };
    const issued = await session(["git.inspect"]);

    const response = await routeGatewayRequest(
      request("/v1/git/log?max=999", issued.token),
      dependencies(repository, binary, runner),
    );
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  });
});
