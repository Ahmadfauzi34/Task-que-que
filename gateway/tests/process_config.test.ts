import { describe, expect, test } from "bun:test";

import { loadGatewayConfig } from "../src/config";

describe("registered process substrate configuration", () => {
  test("is disabled by default and accepts a normalized absolute registry path", () => {
    const disabled = loadGatewayConfig({ GATEWAY_API_TOKEN: "secret" });
    expect(disabled.processRegistryFile).toBeNull();

    const configured = loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_PROCESS_REGISTRY_FILE: "/data/data/com.termux/files/home/.task-queue/../.task-queue/process-registry.json",
    });
    expect(configured.processRegistryFile).toBe(
      "/data/data/com.termux/files/home/.task-queue/process-registry.json",
    );
  });

  test("rejects relative/root registry paths", () => {
    expect(() => loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_PROCESS_REGISTRY_FILE: "./process-registry.json",
    })).toThrow("absolute POSIX path");

    expect(() => loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_PROCESS_REGISTRY_FILE: "/",
    })).toThrow("must identify a registry file");
  });

  test("keeps the process control plane outside writable filesystem delegation", () => {
    const base = {
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_FILESYSTEM_ROOT: "/srv/workspace",
      GATEWAY_FILESYSTEM_MUTATOR_BIN: "/opt/task-queue/fs-mutator",
    };

    expect(() => loadGatewayConfig({
      ...base,
      GATEWAY_PROCESS_REGISTRY_FILE: "/srv/workspace/control/process-registry.json",
    })).toThrow("GATEWAY_PROCESS_REGISTRY_FILE must be outside");

    const safe = loadGatewayConfig({
      ...base,
      GATEWAY_PROCESS_REGISTRY_FILE: "/etc/task-queue/process-registry.json",
    });
    expect(safe.processRegistryFile).toBe("/etc/task-queue/process-registry.json");
  });
});
