import { describe, expect, test } from "bun:test";

import { loadGatewayConfig } from "../src/config";

describe("registered process substrate configuration", () => {
  test("is disabled by default and accepts normalized absolute process paths", () => {
    const disabled = loadGatewayConfig({ GATEWAY_API_TOKEN: "secret" });
    expect(disabled.processRegistryFile).toBeNull();
    expect(disabled.processExecBin).toBeNull();

    const configured = loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_PROCESS_REGISTRY_FILE: "/data/data/com.termux/files/home/.task-queue/../.task-queue/process-registry.json",
      GATEWAY_PROCESS_EXEC_BIN: "/data/data/com.termux/files/home/.local/../.local/bin/robust-sinkhorn-process-exec",
    });
    expect(configured.processRegistryFile).toBe(
      "/data/data/com.termux/files/home/.task-queue/process-registry.json",
    );
    expect(configured.processExecBin).toBe(
      "/data/data/com.termux/files/home/.local/bin/robust-sinkhorn-process-exec",
    );
  });

  test("rejects relative/root process control paths", () => {
    expect(() => loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_PROCESS_REGISTRY_FILE: "./process-registry.json",
    })).toThrow("absolute POSIX path");

    expect(() => loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_PROCESS_REGISTRY_FILE: "/",
    })).toThrow("must identify a registry file");

    expect(() => loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_PROCESS_EXEC_BIN: "./process-exec",
    })).toThrow("absolute POSIX path");

    expect(() => loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_PROCESS_EXEC_BIN: "/",
    })).toThrow("must identify a binary");
  });

  test("keeps process registry and helper outside writable filesystem delegation", () => {
    const base = {
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_FILESYSTEM_ROOT: "/srv/workspace",
      GATEWAY_FILESYSTEM_MUTATOR_BIN: "/opt/task-queue/fs-mutator",
    };

    expect(() => loadGatewayConfig({
      ...base,
      GATEWAY_PROCESS_REGISTRY_FILE: "/srv/workspace/control/process-registry.json",
    })).toThrow("GATEWAY_PROCESS_REGISTRY_FILE must be outside");

    expect(() => loadGatewayConfig({
      ...base,
      GATEWAY_PROCESS_EXEC_BIN: "/srv/workspace/bin/process-exec",
    })).toThrow("GATEWAY_PROCESS_EXEC_BIN must be outside");

    const safe = loadGatewayConfig({
      ...base,
      GATEWAY_PROCESS_REGISTRY_FILE: "/etc/task-queue/process-registry.json",
      GATEWAY_PROCESS_EXEC_BIN: "/opt/task-queue/robust-sinkhorn-process-exec",
    });
    expect(safe.processRegistryFile).toBe("/etc/task-queue/process-registry.json");
    expect(safe.processExecBin).toBe("/opt/task-queue/robust-sinkhorn-process-exec");
  });
});
