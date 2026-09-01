import { expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

test(
  "runs bounded remote-agent capability through the same Rust broker",
  async () => {
    const child = Bun.spawn(["bash", "tests/reference-remote-agent-worker-smoke.sh"], {
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
        `remote agent proof failed with exit ${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }

    expect(stdout).toContain("fixed endpoint from worker config     : OK");
    expect(stdout).toContain("task-supplied url/method control       : NONE");
    expect(stdout).toContain("remote call exceeds initial lease      : OK (900ms > 600ms)");
    expect(stdout).toContain("Reference remote agent worker integration: OK");
  },
  30_000,
);
