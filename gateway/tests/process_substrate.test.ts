import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "tqq-process-substrate-"));
  cleanup.push(base);
  const cwd = await realpath(base);
  const binary = await realpath(process.execPath);
  const registryPath = join(cwd, "process-registry.json");
  const descriptor = {
    name: "proof.command",
    binary,
    args: ["--version"],
    cwd,
    timeout_ms: 1_000,
    max_output_bytes: 64 * 1024,
  };
  await writeFile(
    registryPath,
    `${JSON.stringify({ version: 1, commands: [descriptor] })}\n`,
    "utf8",
  );
  return { base, cwd, binary, registryPath, descriptor };
}

describe("registered process substrate", () => {
  test("loads only canonical native executables, registry and cwd identities", async () => {
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

    const script = join(base, "script.sh");
    await writeFile(script, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(script, 0o700);
    const scriptRegistry = join(base, "script.json");
    await writeFile(
      scriptRegistry,
      `${JSON.stringify({
        version: 1,
        commands: [{
          name: "proof.command",
          binary: script,
          args: [],
          cwd,
          timeout_ms: 1_000,
          max_output_bytes: 1_024,
        }],
      })}\n`,
      "utf8",
    );
    await expect(loadRegisteredProcessRegistry(scriptRegistry)).rejects.toThrow(
      "native ELF executable",
    );
  });

  test("keeps registry, executable and cwd outside a writable delegated root", async () => {
    const { base, cwd, binary, descriptor } = await fixture();
    const writableRoot = join(base, "workspace");
    await mkdir(writableRoot);

    const registryInside = join(writableRoot, "registry.json");
    await writeFile(
      registryInside,
      `${JSON.stringify({ version: 1, commands: [descriptor] })}\n`,
      "utf8",
    );
    await expect(
      loadRegisteredProcessRegistry(registryInside, writableRoot),
    ).rejects.toThrow("registry must be outside the writable filesystem root");

    const binaryInside = join(writableRoot, "registered-tool");
    await writeFile(binaryInside, await Bun.file(binary).arrayBuffer());
    await chmod(binaryInside, 0o700);
    const binaryRegistry = join(base, "binary-inside.json");
    await writeFile(
      binaryRegistry,
      `${JSON.stringify({
        version: 1,
        commands: [{ ...descriptor, binary: binaryInside }],
      })}\n`,
      "utf8",
    );
    await expect(
      loadRegisteredProcessRegistry(binaryRegistry, writableRoot),
    ).rejects.toThrow("binary must be outside the writable filesystem root");

    const cwdRegistry = join(base, "cwd-inside.json");
    await writeFile(
      cwdRegistry,
      `${JSON.stringify({
        version: 1,
        commands: [{ ...descriptor, binary, cwd: writableRoot }],
      })}\n`,
      "utf8",
    );
    await expect(
      loadRegisteredProcessRegistry(cwdRegistry, writableRoot),
    ).rejects.toThrow("cwd must be outside the writable filesystem root");

    const safeRegistry = join(base, "safe.json");
    await writeFile(
      safeRegistry,
      `${JSON.stringify({ version: 1, commands: [descriptor] })}\n`,
      "utf8",
    );
    expect((await loadRegisteredProcessRegistry(safeRegistry, writableRoot)).commands.size).toBe(1);
    expect(cwd).toBe(base);
  });

  test("fails closed before process execution on unknown command, cancellation and bad helper", async () => {
    const { registryPath } = await fixture();
    const registry = await loadRegisteredProcessRegistry(registryPath);

    expect(await runRegisteredProcess(registry, "proof.missing", {
      helperBin: "/definitely/missing/process-exec",
    })).toEqual({ ok: false, error: "unregistered_process" });

    const controller = new AbortController();
    controller.abort();
    expect(await runRegisteredProcess(registry, "proof.command", {
      helperBin: "/definitely/missing/process-exec",
      signal: controller.signal,
    })).toEqual({ ok: false, error: "process_cancelled" });

    expect(await runRegisteredProcess(registry, "proof.command", {
      helperBin: "/definitely/missing/process-exec",
    })).toEqual({ ok: false, error: "process_unavailable" });
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
