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

  test("keeps executable and Git control planes outside a writable filesystem delegation", () => {
    const base = {
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_FILESYSTEM_ROOT: "/srv/workspace",
      GATEWAY_FILESYSTEM_MUTATOR_BIN: "/opt/task-queue/fs-mutator",
    };

    expect(() => loadGatewayConfig({
      ...base,
      GATEWAY_FILESYSTEM_MUTATOR_BIN: "/srv/workspace/bin/fs-mutator",
    })).toThrow("GATEWAY_FILESYSTEM_MUTATOR_BIN must be outside");

    expect(() => loadGatewayConfig({
      ...base,
      GATEWAY_GIT_REPOSITORY: "/srv/workspace/repository",
      GATEWAY_GIT_BIN: "/usr/bin/git",
    })).toThrow("GATEWAY_GIT_REPOSITORY control directory must be outside");

    expect(() => loadGatewayConfig({
      ...base,
      GATEWAY_GIT_REPOSITORY: "/srv/repository",
      GATEWAY_GIT_BIN: "/srv/workspace/bin/git",
    })).toThrow("GATEWAY_GIT_BIN must be outside");

    const safe = loadGatewayConfig({
      GATEWAY_API_TOKEN: "secret",
      GATEWAY_FILESYSTEM_ROOT: "/srv/repository/src",
      GATEWAY_FILESYSTEM_MUTATOR_BIN: "/opt/task-queue/fs-mutator",
      GATEWAY_GIT_REPOSITORY: "/srv/repository",
      GATEWAY_GIT_BIN: "/usr/bin/git",
    });
    expect(safe.filesystemRoot).toBe("/srv/repository/src");
    expect(safe.gitRepository).toBe("/srv/repository");
  });
});
