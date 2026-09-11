import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CAPABILITY_AUTHORITY,
  CAPABILITY_DEPTH,
  type CapabilityGrant,
} from "../src/capabilities";
import {
  loadRegisteredProcessRegistry,
  runRegisteredProcess,
  type RegisteredProcessDescriptor,
} from "../src/process-substrate";

const cleanup: string[] = [];

const invokeGrant = (name: string): CapabilityGrant => ({
  depth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
  authority: CAPABILITY_AUTHORITY.INVOKE,
  scopes: [`process.command.${name}`],
});

const mutateGrant = (name: string): CapabilityGrant => ({
  depth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
  authority: CAPABILITY_AUTHORITY.MUTATE_SCOPED,
  scopes: [`process.command.${name}`],
});

function readonlyCommand(
  descriptor: Omit<RegisteredProcessDescriptor, "authority" | "required_scope" | "mutates_state">,
): RegisteredProcessDescriptor {
  return {
    ...descriptor,
    authority: "invoke",
    required_scope: `process.command.${descriptor.name}`,
    mutates_state: false,
  };
}

function mutatingCommand(
  descriptor: Omit<RegisteredProcessDescriptor, "authority" | "required_scope" | "mutates_state">,
): RegisteredProcessDescriptor {
  return {
    ...descriptor,
    authority: "mutate_scoped",
    required_scope: `process.command.${descriptor.name}`,
    mutates_state: true,
  };
}

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
  await writeFile(path, `${JSON.stringify({ version: 2, commands: descriptors })}\n`, "utf8");
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
  test("routes a scoped A1 registered command through the fd-bound helper", async () => {
    const { base, cwd, helper } = await fixtureBase();
    const descriptor = readonlyCommand({
      name: "proof.fd-bound",
      binary: helper,
      args: ["--self-proof-child", "pr49"],
      cwd,
      timeout_ms: 2_000,
      max_output_bytes: 16 * 1024,
    });
    const registryPath = await writeRegistry(base, [descriptor]);
    const registry = await loadRegisteredProcessRegistry(registryPath);

    process.env.TASK_QUEUE_PROCESS_SHOULD_NOT_LEAK = "secret";
    const result = await runRegisteredProcess(registry, descriptor.name, {
      helperBin: helper,
      grant: invokeGrant(descriptor.name),
    });

    expect(result.ok).toBe(true);
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("fd_bound_child=OK");
    expect(result.stdout).toContain("marker=pr49");
    expect(result.stdout).toContain(`cwd=${cwd}`);
    expect(result.stdout).toContain("lang=C");
    expect(result.stdout).toContain("lc_all=C");
    expect(result.stdout).toContain("path=/nonexistent");
    expect(result.stdout).toContain("leaked=ABSENT");
  });

  test("rejects an A1 grant before executing an A3 mutating command", async () => {
    const { base, cwd, helper } = await fixtureBase();
    const pidFile = join(base, "unauthorized-child.pid");
    const descriptor = mutatingCommand({
      name: "proof.mutating-tree",
      binary: helper,
      args: ["--self-proof-tree", pidFile],
      cwd,
      timeout_ms: 250,
      max_output_bytes: 4 * 1024,
    });
    const registryPath = await writeRegistry(base, [descriptor]);
    const registry = await loadRegisteredProcessRegistry(registryPath);

    expect(await runRegisteredProcess(registry, descriptor.name, {
      helperBin: helper,
      grant: invokeGrant(descriptor.name),
    })).toEqual({ ok: false, error: "process_unauthorized" });

    await expect(readFile(pidFile, "utf8")).rejects.toThrow();
  });

  test("kills the whole A3 registered process group on timeout", async () => {
    const { base, cwd, helper } = await fixtureBase();
    const pidFile = join(base, "timeout-child.pid");
    const descriptor = mutatingCommand({
      name: "proof.timeout-tree",
      binary: helper,
      args: ["--self-proof-tree", pidFile],
      cwd,
      timeout_ms: 250,
      max_output_bytes: 4 * 1024,
    });
    const registryPath = await writeRegistry(base, [descriptor]);
    const registry = await loadRegisteredProcessRegistry(registryPath);

    expect(await runRegisteredProcess(registry, descriptor.name, {
      helperBin: helper,
      grant: mutateGrant(descriptor.name),
    })).toEqual({ ok: false, error: "process_timeout" });

    const descendant = Number(await waitForFile(pidFile));
    expect(Number.isInteger(descendant) && descendant > 1).toBe(true);
    await waitUntilNotRunning(descendant);
  });

  test("kills the whole A3 registered process group on cancellation", async () => {
    const { base, cwd, helper } = await fixtureBase();
    const pidFile = join(base, "cancel-child.pid");
    const descriptor = mutatingCommand({
      name: "proof.cancel-tree",
      binary: helper,
      args: ["--self-proof-tree", pidFile],
      cwd,
      timeout_ms: 5_000,
      max_output_bytes: 4 * 1024,
    });
    const registryPath = await writeRegistry(base, [descriptor]);
    const registry = await loadRegisteredProcessRegistry(registryPath);
    const controller = new AbortController();

    const running = runRegisteredProcess(registry, descriptor.name, {
      helperBin: helper,
      grant: mutateGrant(descriptor.name),
      signal: controller.signal,
    });
    const descendant = Number(await waitForFile(pidFile));
    controller.abort();

    expect(await running).toEqual({ ok: false, error: "process_cancelled" });
    expect(Number.isInteger(descendant) && descendant > 1).toBe(true);
    await waitUntilNotRunning(descendant);
  });

  test("kills the scoped A1 helper group when bounded output is exceeded", async () => {
    const { base, cwd, helper } = await fixtureBase();
    const descriptor = readonlyCommand({
      name: "proof.output-bound",
      binary: helper,
      args: ["--self-proof-child", "overflow"],
      cwd,
      timeout_ms: 2_000,
      max_output_bytes: 8,
    });
    const registryPath = await writeRegistry(base, [descriptor]);
    const registry = await loadRegisteredProcessRegistry(registryPath);

    expect(await runRegisteredProcess(registry, descriptor.name, {
      helperBin: helper,
      grant: invokeGrant(descriptor.name),
    })).toEqual({ ok: false, error: "process_output_too_large" });
  });
});
