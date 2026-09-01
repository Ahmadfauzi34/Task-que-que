import { expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

test(
  "recovers a cross-capability workflow after the workflow worker is killed",
  async () => {
    const child = Bun.spawn(["bash", "tests/reference-workflow-worker-smoke.sh"], {
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
        `workflow core proof failed with exit ${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }

    expect(stdout).toContain("workflow worker SIGKILL                : INJECTED");
    expect(stdout).toContain("deterministic child idempotency        : OK");
    expect(stdout).toContain("child task ids after restart           : SAME");
    expect(stdout).toContain("cyclic DAG                             : FAILED CLOSED BEFORE CHILD");
    expect(stdout).toContain("Reference workflow core integration: OK");
  },
  60_000,
);
