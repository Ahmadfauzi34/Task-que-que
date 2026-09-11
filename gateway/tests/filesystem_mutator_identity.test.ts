import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdmissionController } from "../src/admission";
import type { GatewayDependencies } from "../src/app";
import type { GatewayConfig } from "../src/config";
import { filesystemMutationAvailable } from "../src/filesystem-mutation-api";
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

function dependencies(root: string, binary: string): GatewayDependencies {
  const config: GatewayConfig = {
    hostname: "127.0.0.1",
    port: 3000,
    queueDaemonOrigin: "http://127.0.0.1:7331",
    workerBrokerOrigin: "http://127.0.0.1:7332",
    filesystemRoot: root,
    filesystemMutatorBin: binary,
    gitRepository: null,
    gitBin: null,
    apiToken: "root-secret",
    allowUnauthenticated: false,
    upstreamTimeoutMs: 1_000,
    enqueueRatePerSecond: 10,
    enqueueBurst: 20,
    maxActiveTasks: 256,
  };
  return { config, registry: TASK_REGISTRY, admissionController };
}

describe("filesystem mutator executable identity", () => {
  test("accepts only a canonical regular executable and rejects a symlink before spawn", async () => {
    const base = await mkdtemp(join(tmpdir(), "tqq-mutator-identity-"));
    cleanup.push(base);
    const root = join(base, "root");
    const binDir = join(base, "bin");
    const binary = join(binDir, "mutator");
    const binaryLink = join(binDir, "mutator-link");
    const sentinel = join(base, "invoked");
    await mkdir(root);
    await mkdir(binDir);
    await writeFile(
      binary,
      `#!/bin/sh\nprintf 'invoked\\n' > '${sentinel}'\nexit 0\n`,
      "utf8",
    );
    await chmod(binary, 0o700);
    await symlink(binary, binaryLink);

    expect(await filesystemMutationAvailable(dependencies(root, binaryLink))).toBe(false);
    expect(await Bun.file(sentinel).exists()).toBe(false);

    expect(await filesystemMutationAvailable(dependencies(root, binary))).toBe(true);
    expect(await Bun.file(sentinel).exists()).toBe(true);
  });
});
