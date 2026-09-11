import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadRegisteredProcessRegistry,
  runRegisteredProcess,
} from "../src/process-substrate";

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
  delete process.env.TASK_QUEUE_PROCESS_SHOULD_NOT_LEAK;
});

async function fixture(
  options: {
    args?: string[];
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
) {
  const base = await mkdtemp(join(tmpdir(), "tqq-process-substrate-"));
  cleanup.push(base);
  const cwd = await realpath(base);
  const binary = await realpath(process.execPath);
  const registryPath = join(cwd, "process-registry.json");
  const descriptor = {
    name: "proof.command",
    binary,
    args: options.args ?? [
      "-e",
      "console.log(JSON.stringify({cwd:process.cwd(), leaked:process.env.TASK_QUEUE_PROCESS_SHOULD_NOT_LEAK ?? null, path:process.env.PATH ?? null}))",
    ],
    cwd,
    timeout_ms: options.timeoutMs ?? 1_000,
    max_output_bytes: options.maxOutputBytes ?? 64 * 1024,
  };
  await writeFile(
    registryPath,
    `${JSON.stringify({ version: 1, commands: [descriptor] })}\n`,
    "utf8",
  );
  return { base, cwd, binary, registryPath, descriptor };
}

describe("registered process substrate", () => {
  test("loads only a canonical registry with canonical executable and cwd identities", async () => {
    const { base, registryPath, binary, cwd } = await fixture();
    const registry = await loadRegisteredProcessRegistry(registryPath);
    expect(registry.version).toBe(1);
    expect(registry.source).toBe(registryPath);
    expect(registry.commands.get("proof.command")).toMatchObject({
      binary,
      cwd,
      timeout_ms: 1_000,
    });

    const registryLink = join(base, "registry-link.json");
    await symlink(registryPath, registryLink);
    await expect(loadRegisteredProcessRegistry(registryLink)).rejects.toThrow(
      "registry is unavailable",
    );

    const binaryLink = join(base, "binary-link");
    await symlink(binary, binaryLink);
    const badRegistry = join(base, "bad-binary.json");
    await writeFile(
      badRegistry,
      `${JSON.stringify({
        version: 1,
        commands: [{
          name: "proof.command",
          binary: binaryLink,
          args: [],
          cwd,
          timeout_ms: 1_000,
          max_output_bytes: 1_024,
        }],
      })}\n`,
      "utf8",
    );
    await expect(loadRegisteredProcessRegistry(badRegistry)).rejects.toThrow(
      "binary must be a regular file",
    );
  });

  test("runs only fixed registered argv in a scrubbed minimal environment", async () => {
    const { registryPath, cwd } = await fixture();
    process.env.TASK_QUEUE_PROCESS_SHOULD_NOT_LEAK = "secret";
    const registry = await loadRegisteredProcessRegistry(registryPath);

    const missing = await runRegisteredProcess(registry, "proof.missing");
    expect(missing).toEqual({ ok: false, error: "unregistered_process" });

    const result = await runRegisteredProcess(registry, "proof.command");
    expect(result.ok).toBe(true);
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse((result.stdout ?? "").trim()) as Record<string, unknown>;
    expect(parsed).toEqual({ cwd, leaked: null, path: "/nonexistent" });
  });

  test("fails closed on bounded output overflow", async () => {
    const { registryPath } = await fixture({
      args: ["-e", "console.log('x'.repeat(8192))"],
      maxOutputBytes: 256,
    });
    const registry = await loadRegisteredProcessRegistry(registryPath);
    expect(await runRegisteredProcess(registry, "proof.command")).toEqual({
      ok: false,
      error: "process_output_too_large",
    });
  });

  test("kills a registered command that exceeds its server-owned timeout", async () => {
    const { registryPath } = await fixture({
      args: ["-e", "await new Promise((resolve) => setTimeout(resolve, 1000))"],
      timeoutMs: 100,
    });
    const registry = await loadRegisteredProcessRegistry(registryPath);
    expect(await runRegisteredProcess(registry, "proof.command")).toEqual({
      ok: false,
      error: "process_timeout",
    });
  });

  test("rejects duplicate names and caller-like descriptor ambiguity", async () => {
    const { base, cwd, binary } = await fixture();
    const duplicate = join(base, "duplicate.json");
    const descriptor = {
      name: "proof.command",
      binary,
      args: [],
      cwd,
      timeout_ms: 1_000,
      max_output_bytes: 1_024,
    };
    await writeFile(
      duplicate,
      `${JSON.stringify({ version: 1, commands: [descriptor, descriptor] })}\n`,
      "utf8",
    );
    await expect(loadRegisteredProcessRegistry(duplicate)).rejects.toThrow(
      "duplicate registered process name",
    );

    const extraField = join(base, "extra-field.json");
    await writeFile(
      extraField,
      `${JSON.stringify({
        version: 1,
        commands: [{ ...descriptor, shell: true }],
      })}\n`,
      "utf8",
    );
    await expect(loadRegisteredProcessRegistry(extraField)).rejects.toThrow(
      "descriptor has an invalid schema",
    );
  });
});
