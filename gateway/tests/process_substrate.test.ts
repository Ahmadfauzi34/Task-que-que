import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CAPABILITY_AUTHORITY,
  CAPABILITY_DEPTH,
  type CapabilityGrant,
} from "../src/capabilities";
import {
  evaluateRegisteredProcessGrant,
  loadRegisteredProcessRegistry,
  runRegisteredProcess,
} from "../src/process-substrate";

const cleanup: string[] = [];

const invokeGrant = (scope = "process.command.proof.command"): CapabilityGrant => ({
  depth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
  authority: CAPABILITY_AUTHORITY.INVOKE,
  scopes: [scope],
});

const mutateGrant = (scope: string): CapabilityGrant => ({
  depth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
  authority: CAPABILITY_AUTHORITY.MUTATE_SCOPED,
  scopes: [scope],
});

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
    authority: "invoke" as const,
    required_scope: "process.command.proof.command",
    mutates_state: false,
  };
  await writeFile(
    registryPath,
    `${JSON.stringify({ version: 2, commands: [descriptor] })}\n`,
    "utf8",
  );
  return { base, cwd, binary, registryPath, descriptor };
}

describe("registered process substrate", () => {
  test("loads only canonical native executables, registry and cwd identities", async () => {
    const { base, registryPath, binary, cwd } = await fixture();
    const registry = await loadRegisteredProcessRegistry(registryPath);
    expect(registry.version).toBe(2);
    expect(registry.source).toBe(registryPath);
    expect(registry.commands.get("proof.command")).toMatchObject({
      binary,
      cwd,
      timeout_ms: 1_000,
      authority: "invoke",
      required_scope: "process.command.proof.command",
      mutates_state: false,
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
        version: 2,
        commands: [{ ...registry.commands.get("proof.command"), binary: binaryLink }],
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
        version: 2,
        commands: [{ ...registry.commands.get("proof.command"), binary: script }],
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
      `${JSON.stringify({ version: 2, commands: [descriptor] })}\n`,
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
        version: 2,
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
        version: 2,
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
      `${JSON.stringify({ version: 2, commands: [descriptor] })}\n`,
      "utf8",
    );
    expect((await loadRegisteredProcessRegistry(safeRegistry, writableRoot)).commands.size).toBe(1);
    expect(cwd).toBe(base);
  });

  test("rejects depth, authority and scope before helper execution", async () => {
    const { registryPath } = await fixture();
    const registry = await loadRegisteredProcessRegistry(registryPath);
    const descriptor = registry.commands.get("proof.command");
    expect(descriptor).toBeDefined();

    expect(evaluateRegisteredProcessGrant(descriptor!, {
      depth: CAPABILITY_DEPTH.ORCHESTRATE,
      authority: CAPABILITY_AUTHORITY.PRIVILEGED_DELEGATED,
      scopes: ["process.command.proof.command"],
    })).toMatchObject({ allowed: false, blockedBy: ["depth"] });

    expect(evaluateRegisteredProcessGrant(descriptor!, {
      depth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
      authority: CAPABILITY_AUTHORITY.OBSERVE,
      scopes: ["process.command.proof.command"],
    })).toMatchObject({ allowed: false, blockedBy: ["authority"] });

    expect(evaluateRegisteredProcessGrant(descriptor!, invokeGrant("process.command.other")))
      .toMatchObject({ allowed: false, blockedBy: ["scope"] });

    expect(evaluateRegisteredProcessGrant(descriptor!, invokeGrant("process.command.*")))
      .toMatchObject({ allowed: true, blockedBy: [] });

    for (const grant of [
      {
        depth: CAPABILITY_DEPTH.ORCHESTRATE,
        authority: CAPABILITY_AUTHORITY.PRIVILEGED_DELEGATED,
        scopes: ["process.command.proof.command"],
      },
      {
        depth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
        authority: CAPABILITY_AUTHORITY.OBSERVE,
        scopes: ["process.command.proof.command"],
      },
      invokeGrant("process.command.other"),
    ] satisfies CapabilityGrant[]) {
      expect(await runRegisteredProcess(registry, "proof.command", {
        helperBin: "/definitely/missing/process-exec",
        grant,
      })).toEqual({ ok: false, error: "process_unauthorized" });
    }
  });

  test("requires A3 for mutating registered commands and exact command scope", async () => {
    const { base, binary, cwd } = await fixture();
    const descriptor = {
      name: "proof.mutate",
      binary,
      args: [],
      cwd,
      timeout_ms: 1_000,
      max_output_bytes: 1_024,
      authority: "mutate_scoped" as const,
      required_scope: "process.command.proof.mutate",
      mutates_state: true,
    };
    const path = join(base, "mutating.json");
    await writeFile(path, `${JSON.stringify({ version: 2, commands: [descriptor] })}\n`, "utf8");
    const registry = await loadRegisteredProcessRegistry(path);
    const loaded = registry.commands.get("proof.mutate")!;

    expect(evaluateRegisteredProcessGrant(loaded, invokeGrant("process.command.proof.mutate")))
      .toMatchObject({ allowed: false, blockedBy: ["authority"] });
    expect(evaluateRegisteredProcessGrant(loaded, mutateGrant("process.command.proof.mutate")))
      .toMatchObject({ allowed: true, blockedBy: [] });

    expect(await runRegisteredProcess(registry, "proof.mutate", {
      helperBin: "/definitely/missing/process-exec",
      grant: invokeGrant("process.command.proof.mutate"),
    })).toEqual({ ok: false, error: "process_unauthorized" });
  });

  test("fails closed before process execution on unknown command, cancellation and bad helper", async () => {
    const { registryPath } = await fixture();
    const registry = await loadRegisteredProcessRegistry(registryPath);

    expect(await runRegisteredProcess(registry, "proof.missing", {
      helperBin: "/definitely/missing/process-exec",
      grant: invokeGrant(),
    })).toEqual({ ok: false, error: "unregistered_process" });

    const controller = new AbortController();
    controller.abort();
    expect(await runRegisteredProcess(registry, "proof.command", {
      helperBin: "/definitely/missing/process-exec",
      grant: invokeGrant(),
      signal: controller.signal,
    })).toEqual({ ok: false, error: "process_cancelled" });

    expect(await runRegisteredProcess(registry, "proof.command", {
      helperBin: "/definitely/missing/process-exec",
      grant: invokeGrant(),
    })).toEqual({ ok: false, error: "process_unavailable" });
  });

  test("rejects contradictory policy, scope aliasing, duplicate names and extra fields", async () => {
    const { base, cwd, binary, descriptor } = await fixture();
    const duplicate = join(base, "duplicate.json");
    await writeFile(
      duplicate,
      `${JSON.stringify({ version: 2, commands: [descriptor, descriptor] })}\n`,
      "utf8",
    );
    await expect(loadRegisteredProcessRegistry(duplicate)).rejects.toThrow(
      "duplicate registered process name",
    );

    const extraField = join(base, "extra-field.json");
    await writeFile(
      extraField,
      `${JSON.stringify({
        version: 2,
        commands: [{ ...descriptor, shell: true }],
      })}\n`,
      "utf8",
    );
    await expect(loadRegisteredProcessRegistry(extraField)).rejects.toThrow(
      "descriptor has an invalid schema",
    );

    const contradictory = join(base, "contradictory.json");
    await writeFile(
      contradictory,
      `${JSON.stringify({
        version: 2,
        commands: [{ ...descriptor, authority: "invoke", mutates_state: true }],
      })}\n`,
      "utf8",
    );
    await expect(loadRegisteredProcessRegistry(contradictory)).rejects.toThrow(
      "authority and mutates_state are inconsistent",
    );

    const aliasedScope = join(base, "aliased-scope.json");
    await writeFile(
      aliasedScope,
      `${JSON.stringify({
        version: 2,
        commands: [{ ...descriptor, required_scope: "process.command.someone-else" }],
      })}\n`,
      "utf8",
    );
    await expect(loadRegisteredProcessRegistry(aliasedScope)).rejects.toThrow(
      "required_scope must be exactly process.command.proof.command",
    );
  });
});
