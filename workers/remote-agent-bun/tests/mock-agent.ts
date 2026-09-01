import { appendFile } from "node:fs/promises";

const token = process.env.MOCK_AGENT_TOKEN ?? "reference-remote-secret";
const logPath = process.env.MOCK_AGENT_LOG;
const delayMs = Number(process.env.MOCK_AGENT_DELAY_MS ?? "900");

if (!logPath) {
  throw new Error("MOCK_AGENT_LOG is required");
}
if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
  throw new Error("MOCK_AGENT_DELAY_MS is invalid");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 7440,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }
    if (request.method !== "POST" || url.pathname !== "/invoke") {
      return new Response("not found", { status: 404 });
    }
    if (request.headers.get("authorization") !== `Bearer ${token}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const idempotency = request.headers.get("idempotency-key");
    const taskHeader = request.headers.get("x-task-queue-task-id");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    const record = body as Record<string, unknown>;
    if (
      record.schema_version !== 1 ||
      !Number.isSafeInteger(record.task_id) ||
      typeof taskHeader !== "string" ||
      String(record.task_id) !== taskHeader ||
      idempotency !== `task-queue-${record.task_id}` ||
      !Object.prototype.hasOwnProperty.call(record, "input")
    ) {
      return Response.json({ error: "invalid_envelope" }, { status: 400 });
    }

    await appendFile(
      logPath,
      `${JSON.stringify({
        task_id: record.task_id,
        request_id: record.request_id ?? null,
        auth_ok: true,
        idempotency_ok: true,
      })}\n`,
      "utf8",
    );

    await sleep(delayMs);
    return Response.json({
      result: {
        accepted: true,
        task_id: record.task_id,
        input_kind:
          record.input === null
            ? "null"
            : Array.isArray(record.input)
              ? "array"
              : typeof record.input,
      },
      meta: { agent: "bounded-mock" },
    });
  },
});

console.log(`mock remote agent listening on http://${server.hostname}:${server.port}/invoke`);
