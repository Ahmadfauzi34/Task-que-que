import { describe, expect, test } from "bun:test";

import { loadGatewayConfig } from "../src/config";

describe("delegated filesystem configuration", () => {
  test("is disabled by default and accepts explicit bounded absolute provider paths", () => {
    const disabled = loadGatewayConfig({ GATEWAY_API_TOKEN: "secret" });
    expect(disabled.filesystemRoot).toBeNull();
    expect(disabled.filesystemMutatorBin).toBeNull();

    const configured = loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_FILESYSTEM_ROOT: "/data/data/com.termux/files/home/workspace/../workspace",
      GATEWAY_FILESYSTEM_MUTATOR_BIN:
        "/data/data/com.termux/files/home/.local/bin/../bin/robust-sinkhorn-fs-mutator",
    });
    expect(configured.filesystemRoot).toBe("/data/data/com.termux/files/home/workspace");
    expect(configured.filesystemMutatorBin).toBe(
      "/data/data/com.termux/files/home/.local/bin/robust-sinkhorn-fs-mutator",
    );
  });

  test("rejects relative paths and refuses delegating the host filesystem root", () => {
    expect(() => loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_FILESYSTEM_ROOT: "./workspace",
    })).toThrow("absolute POSIX path");

    expect(() => loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_FILESYSTEM_ROOT: "/",
    })).toThrow("must not delegate the filesystem root");

    expect(() => loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_FILESYSTEM_MUTATOR_BIN: "./robust-sinkhorn-fs-mutator",
    })).toThrow("absolute POSIX path");

    expect(() => loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_FILESYSTEM_MUTATOR_BIN: "/",
    })).toThrow("must identify a binary");
  });
});
