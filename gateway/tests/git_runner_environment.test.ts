import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultGitMetadataRunner } from "../src/git-api";

const cleanup: string[] = [];
const envRestore = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
  if (!envRestore.has(key)) envRestore.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(async () => {
  for (const [key, value] of envRestore) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envRestore.clear();

  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Git metadata subprocess environment", () => {
  test("scrubs inherited Git controls and pins non-executing metadata safeguards", async () => {
    const base = await mkdtemp(join(tmpdir(), "tqq-git-env-"));
    cleanup.push(base);
    const repository = join(base, "repo");
    const binary = join(base, "git-probe");
    await mkdir(repository);
    await writeFile(
      binary,
      `#!/bin/sh\nprintf 'GIT_DIR=%s\\n' "\${GIT_DIR-}"\nprintf 'GIT_TRACE=%s\\n' "\${GIT_TRACE-}"\nprintf 'GIT_NO_LAZY_FETCH=%s\\n' "\${GIT_NO_LAZY_FETCH-}"\nprintf 'GIT_CONFIG_GLOBAL=%s\\n' "\${GIT_CONFIG_GLOBAL-}"\nprintf 'GIT_CONFIG_NOSYSTEM=%s\\n' "\${GIT_CONFIG_NOSYSTEM-}"\nprintf 'PAGER=%s\\n' "\${PAGER-}"\nprintf 'ARGS=%s\\n' "$*"\n`,
      "utf8",
    );
    await chmod(binary, 0o700);

    setEnv("GIT_DIR", "/attacker/git-dir");
    setEnv("GIT_TRACE", "1");
    setEnv("GIT_CONFIG_COUNT", "1");
    setEnv("GIT_CONFIG_KEY_0", "core.fsmonitor");
    setEnv("GIT_CONFIG_VALUE_0", "/attacker/helper");
    setEnv("PAGER", "/attacker/pager");

    const result = await defaultGitMetadataRunner({
      binary,
      repository,
      operation: "probe",
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(true);
    const output = result.stdout ?? "";
    expect(output).toContain("GIT_DIR=\n");
    expect(output).toContain("GIT_TRACE=\n");
    expect(output).toContain("GIT_NO_LAZY_FETCH=1\n");
    expect(output).toContain("GIT_CONFIG_GLOBAL=/dev/null\n");
    expect(output).toContain("GIT_CONFIG_NOSYSTEM=1\n");
    expect(output).toContain("PAGER=cat\n");
    expect(output).toContain("--no-pager --no-optional-locks");
    expect(output).toContain("core.fsmonitor=false");
    expect(output).toContain("core.hooksPath=/dev/null");
    expect(output).toContain("core.alternateRefsCommand=:");
    expect(output).not.toContain("/attacker");
  });
});
