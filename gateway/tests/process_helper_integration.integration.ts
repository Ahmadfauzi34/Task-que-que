import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadRegisteredProcessRegistry,
  runRegisteredProcess,
  type RegisteredProcessDescriptor,
} from "../src/process-substrate";

const cleanup: string[] = [];

afterEach(async () => {
  delete process.env.TASK_QUEUE_PROCESS_SHOULD_NOT_LEAK;
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

async function writeRegistry(
  base: string,
  descriptors: RegisteredProcessDescriptor[],
): Promise<string> {
  const path = join(base, `registry-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(path, `${JSON.stringify({ version: 1, commands: descriptors })}\n`, "utf8");
  return path;
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return (await readFile(path, "utf8")).trim();
    } catch {
      await Bun.sleep(25);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitUntilNotRunning(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      const state = closeParen >= 0 ? stat.slice(closeParen + 2, closeParen + 3) : "";
      if (state === "Z") return;
    } catch {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`descendant ${pid} remained running after process-group termination`);
}

async function fixtureBase(): Promise<{ base: string; cwd: string; helper: string }> {
  const configured = process.env.TASK_QUEUE_PROCESS_EXEC_BIN;
  if (!configured) throw new Error("TASK_QUEUE_PROCESS_EXEC_BIN is required");
  const helper = await realpath(configured);
  const base = await mkdtemp(join(tmpdir(), "tqq-process-helper-integration-"));
  cleanup.push(base);
  return { base, cwd: await realpath(base), helper };
}

describe("registered process Rust helper integration", () => {
  test("routes a fixed registered command through the fd-bound helper with a scrubbed environment", async () => {
    const { base, cwd, helper } = await fixtureBase();
    const registryPath = await writeRegistry(base, [{
      name: "proof.fd-bound",
      binary: helper,
      args: ["--self-proof-child", "pr48"],
      cwd,
      timeout_ms: 2_000,
      max_output_bytes: 16 * 1024,
    }]);
    const registry = await loadRegisteredProcessRegistry(registryPath);

    process.env.TASK_QUEUE_PROCESS_SHOULD_NOT_LEAK = "secret";
    const result = await runRegisteredProcess(registry, "proof.fd-bound", {
      helperBin: helper,
    });

    expect(result.ok).toBe(true);
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("fd_bound_child=OK");
    expect(result.stdout).toContain("marker=pr48");
    expect(result.stdout).toContain(`cwd=${cwd}`);
    expect(result.stdout).toContain("lang=C");
    expect(result.stdout).toContain("lc_all=C");
    expect(result.stdout).toContain("path=/nonexistent");
    expect(result.stdout).toContain("leaked=ABSENT");
  });

  test("kills the whole registered process group on timeout", async () => {
    const { base, cwd, helper } = await fixtureBase();
    const pidFile = join(base, "timeout-child.pid");
    const registryPath = await writeRegistry(base, [{
      name: "proof.timeout-tree",
      binary: helper,
      args: ["--self-proof-tree", pidFile],
      cwd,
      timeout_ms: 250,
      max_output_bytes: 4 * 1024,
    }]);
    const registry = await loadRegisteredProcessRegistry(registryPath);

    expect(await runRegisteredProcess(registry, "proof.timeout-tree", {
      helperBin: helper,
    })).toEqual({ ok: false, error: "process_timeout" });

    const descendant = Number(await waitForFile(pidFile));
    expect(Number.isInteger(descendant) && descendant > 1).toBe(true);
    await waitUntilNotRunning(descendant);
  });

  test("kills the whole registered process group on cancellation", async () => {
    const { base, cwd, helper } = await fixtureBase();
    const pidFile = join(base, "cancel-child.pid");
    const registryPath = await writeRegistry(base, [{
      name: "proof.cancel-tree",
      binary: helper,
      args: ["--self-proof-tree", pidFile],
      cwd,
      timeout_ms: 5_000,
      max_output_bytes: 4 * 1024,
    }]);
    const registry = await loadRegisteredProcessRegistry(registryPath);
    const controller = new AbortController();

    const running = runRegisteredProcess(registry, "proof.cancel-tree", {
      helperBin: helper,
      signal: controller.signal,
    });
    const descendant = Number(await waitForFile(pidFile));
    controller.abort();

    expect(await running).toEqual({ ok: false, error: "process_cancelled" });
    expect(Number.isInteger(descendant) && descendant > 1).toBe(true);
    await waitUntilNotRunning(descendant);
  });

  test("kills the helper group when bounded output is exceeded", async () => {
    const { base, cwd, helper } = await fixtureBase();
    const registryPath = await writeRegistry(base, [{
      name: "proof.output-bound",
      binary: helper,
      args: ["--self-proof-child", "overflow"],
      cwd,
      timeout_ms: 2_000,
      max_output_bytes: 8,
    }]);
    const registry = await loadRegisteredProcessRegistry(registryPath);

    expect(await runRegisteredProcess(registry, "proof.output-bound", {
      helperBin: helper,
    })).toEqual({ ok: false, error: "process_output_too_large" });
  });
});
