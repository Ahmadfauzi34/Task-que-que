import { expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

test(
  "exports only declared workflow outputs through the public workflow result",
  async () => {
    const child = Bun.spawn(["bash", "tests/reference-workflow-outputs-smoke.sh"], {
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
        `declared workflow output proof failed with exit ${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }

    expect(stdout).toContain("explicit output declassification     : OK");
    expect(stdout).toContain("declared agent result.accepted       : EXPORTED");
    expect(stdout).toContain("undeclared child projection fields   : HIDDEN");
    expect(stdout).toContain("unknown output source                : FAILED CLOSED BEFORE CHILD");
    expect(stdout).toContain("Reference declared workflow outputs: OK");
  },
  60_000,
);
