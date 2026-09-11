import { describe, expect, test } from "bun:test";

import { loadGatewayConfig } from "../src/config";

describe("delegated Git metadata configuration", () => {
  test("is disabled by default and accepts normalized absolute provider paths", () => {
    const disabled = loadGatewayConfig({ GATEWAY_API_TOKEN: "secret" });
    expect(disabled.gitRepository).toBeNull();
    expect(disabled.gitBin).toBeNull();

    const configured = loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_GIT_REPOSITORY: "/data/data/com.termux/files/home/project/../project",
      GATEWAY_GIT_BIN: "/data/data/com.termux/files/usr/bin/../bin/git",
    });
    expect(configured.gitRepository).toBe("/data/data/com.termux/files/home/project");
    expect(configured.gitBin).toBe("/data/data/com.termux/files/usr/bin/git");
  });

  test("rejects relative paths and refuses host-root delegation", () => {
    expect(() => loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_GIT_REPOSITORY: "./project",
    })).toThrow("absolute POSIX path");

    expect(() => loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_GIT_REPOSITORY: "/",
    })).toThrow("must not delegate the filesystem root");

    expect(() => loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_GIT_BIN: "git",
    })).toThrow("absolute POSIX path");

    expect(() => loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_GIT_BIN: "/",
    })).toThrow("must identify a binary");
  });
});
