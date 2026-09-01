import { expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

test(
  "runs cpu and custom vector workers through the same Rust broker with hard isolation",
  async () => {
    const child = Bun.spawn(["bash", "tests/reference-heterogeneous-workers-smoke.sh"], {
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
        `heterogeneous worker proof failed with exit ${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }

    expect(stdout).toContain("hard cpu/vector capability partition : OK");
    expect(stdout).toContain("older high-priority cpu task         : PENDING WITHOUT CPU WORKER");
    expect(stdout).toContain("Reference heterogeneous workers integration: OK");
  },
  30_000,
);
