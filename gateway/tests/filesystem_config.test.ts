import { describe, expect, test } from "bun:test";

import { loadGatewayConfig } from "../src/config";

describe("delegated filesystem configuration", () => {
  test("is disabled by default and accepts an explicit bounded absolute root", () => {
    const disabled = loadGatewayConfig({ GATEWAY_API_TOKEN: "secret" });
    expect(disabled.filesystemRoot).toBeNull();

    const configured = loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_FILESYSTEM_ROOT: "/data/data/com.termux/files/home/workspace/../workspace",
    });
    expect(configured.filesystemRoot).toBe("/data/data/com.termux/files/home/workspace");
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
  });
});
