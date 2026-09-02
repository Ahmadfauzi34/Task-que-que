import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRemoteAgentHandler } from "../../remote-agent-bun/src/remote-handler";

const servers: Bun.Server<unknown>[] = [];
const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("remote-agent handler aborts in-flight response consumption on lease cancellation", async () => {
  let requestObservedResolve!: () => void;
  const requestObserved = new Promise<void>((resolve) => {
    requestObservedResolve = resolve;
  });
  const encoder = new TextEncoder();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requestObservedResolve();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"result":"waiting'));
        },
      });
      return new Response(body, {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  servers.push(server);

  const outputDir = await mkdtemp(join(tmpdir(), "remote-cancel-proof-"));
  cleanupPaths.push(outputDir);
  const handler = createRemoteAgentHandler({
    endpoint: `http://127.0.0.1:${server.port}/invoke`,
    providerId: "cancellation-proof",
    timeoutMs: 10_000,
  });
  const controller = new AbortController();

  const running = handler.handle(
    {
      task_id: 51,
      task_name: "agent.invoke",
      task_type: "remote-agent",
      payload: JSON.stringify({ input: { prompt: "wait" } }),
    },
    { outputDir, signal: controller.signal },
  );

  await requestObserved;
  controller.abort(new Error("lease authority lost"));

  await expect(running).rejects.toThrow();
  expect(await readdir(outputDir)).toEqual([]);
});
