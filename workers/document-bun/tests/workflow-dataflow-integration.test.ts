import { expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

test(
  "passes bounded durable result data from a hash step into a remote-agent step",
  async () => {
    const child = Bun.spawn(["bash", "tests/reference-workflow-dataflow-smoke.sh"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TASK_QUEUE_BUN_BIN: process.execPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `workflow dataflow proof failed with exit ${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }

    expect(stdout).toContain("durable child result projection       : READ ON LOOPBACK ONLY");
    expect(stdout).toContain("hash digest -> remote agent input     : OK");
    expect(stdout).toContain("dependency graph = data authority     : OK");
    expect(stdout).toContain("non-ancestor result reference         : FAILED CLOSED BEFORE CHILD");
    expect(stdout).toContain("public gateway result disclosure      : NONE");
    expect(stdout).toContain("Reference workflow dataflow integration: OK");
  },
  60_000,
);
