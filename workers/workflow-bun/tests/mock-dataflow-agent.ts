import { appendFile } from "node:fs/promises";

const token = process.env.MOCK_DATAFLOW_AGENT_TOKEN ?? "dataflow-remote-secret";
const logPath = process.env.MOCK_DATAFLOW_AGENT_LOG;
const expectedDigest = process.env.MOCK_DATAFLOW_EXPECTED_DIGEST;

if (!logPath) throw new Error("MOCK_DATAFLOW_AGENT_LOG is required");
if (!expectedDigest || !/^[0-9a-f]{64}$/.test(expectedDigest)) {
  throw new Error("MOCK_DATAFLOW_EXPECTED_DIGEST must be a lowercase SHA-256 digest");
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 7441,
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    const envelope = body as Record<string, unknown>;
    if (envelope.input === null || typeof envelope.input !== "object" || Array.isArray(envelope.input)) {
      return Response.json({ error: "invalid_input" }, { status: 400 });
    }
    const input = envelope.input as Record<string, unknown>;
    const digestMatch = input.digest === expectedDigest;
    const bytesMatch = input.bytes === 25;
    if (!digestMatch || !bytesMatch) {
      return Response.json({ error: "unresolved_or_wrong_dataflow_input" }, { status: 422 });
    }

    await appendFile(
      logPath,
      `${JSON.stringify({ task_id: envelope.task_id, digest_match: true, bytes_match: true })}\n`,
      "utf8",
    );

    return Response.json({
      result: { accepted: true, digest_match: true, bytes_match: true },
      meta: { agent: "bounded-dataflow-mock" },
    });
  },
});

console.log(`mock dataflow agent listening on http://${server.hostname}:${server.port}/invoke`);
