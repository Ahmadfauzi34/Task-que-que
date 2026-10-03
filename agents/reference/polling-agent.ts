/**
 * Polling Agent: agen di sandbox yang menjemput kerjaan dari HP.
 *
 * Arsitektur:
 *   1. Poll gateway HP (via tunnel) untuk task workflow.run/agent.invoke
 *   2. Claim task via /v1/agent/* (proxy ke broker)
 *   3. Eksekusi steps via MCP server LOKAL (sandbox-mcp-agent.ts :18090)
 *   4. Lapor hasil balik via /v1/agent/complete
 *
 * Semua koneksi outbound dari sandbox -> tidak ada masalah client-only.
 */

const GATEWAY = process.env.TQQ_GATEWAY_URL ?? "";
const TOKEN = process.env.TQQ_GATEWAY_TOKEN ?? "";
const MCP_URL = process.env.TQQ_MCP_URL ?? "http://127.0.0.1:18090/";
const AGENT_ID = process.env.TQQ_AGENT_ID ?? "sandbox-agent";
const POLL_MS = 2000;

if (!GATEWAY || !TOKEN) {
  console.error("TQQ_GATEWAY_URL dan TQQ_GATEWAY_TOKEN wajib di-set");
  process.exit(1);
}

let sessionToken: string | null = null;

// MCP client ke server lokal
async function mcpCall(tool: string, args: object): Promise<unknown> {
  const rpc = async (method: string, params: unknown, id: number | null) => {
    const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
    if (id !== null) body.id = id;
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error("mcp_local_http_" + res.status);
    return res.json();
  };
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "polling-agent", version: "0.1.0" },
  }, 1);
  if (init.error) throw new Error("mcp_init_failed");
  await rpc("notifications/initialized", {}, null).catch(() => {});
  const call = await rpc("tools/call", { name: tool, arguments: args }, 2);
  if (call.error) throw new Error("mcp_tool_error: " + JSON.stringify(call.error));
  return call.result;
}

// Gateway agent API
async function agentApi(
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${GATEWAY}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function register(): Promise<void> {
  const res = await fetch(`${GATEWAY}/v1/agent/register`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-worker-id": AGENT_ID,
      "x-worker-type": "polling-agent",
      "x-worker-tasks": "workflow.run,agent.invoke",
      "x-worker-capacity": "1",
    },
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => null);
  if ((res.status !== 200 && res.status !== 201) || !data?.session_token) {
    throw new Error(`register gagal: ${res.status} ${JSON.stringify(data)}`);
  }
  sessionToken = data.session_token;
  console.log(`[${AGENT_ID}] registered, session ok`);
}

async function poll(): Promise<void> {
  if (!sessionToken) await register();

  const headers = {
    "x-worker-session": sessionToken!,
    "x-worker-id": AGENT_ID,
  };

  const { status, data } = await agentApi("/v1/agent/claim", {
    tasks: ["workflow.run", "agent.invoke"],
  }, headers);

  if (status === 204 || !data?.task) {
    return; // tidak ada task
  }

  const task = data.task;
  console.log(`[${AGENT_ID}] claimed task ${task.id} (${task.type})`);

  try {
    const result = await executeTask(task);
    await agentApi("/v1/agent/complete", {
      task_id: task.id,
      result,
    }, {
      ...headers,
      "x-task-id": String(task.id),
      "x-lease-generation": String(data.lease_generation ?? task.lease_generation ?? 0),
    });
    console.log(`[${AGENT_ID}] task ${task.id} COMPLETED`);
  } catch (e) {
    await agentApi("/v1/agent/fail", {
      task_id: task.id,
      error: (e as Error).message,
    }, {
      ...headers,
      "x-task-id": String(task.id),
      "x-lease-generation": String(data.lease_generation ?? task.lease_generation ?? 0),
    });
    console.log(`[${AGENT_ID}] task ${task.id} FAILED: ${(e as Error).message}`);
  }
}

async function executeTask(task: any): Promise<unknown> {
  const payload = typeof task.payload_json === "string"
    ? JSON.parse(task.payload_json)
    : task.payload_json;

  if (task.type === "workflow.run") {
    const steps = payload?.steps;
    if (!Array.isArray(steps)) throw new Error("invalid steps");
    const results: unknown[] = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      // Hanya eksekusi step untuk agen ini (sesuai kontrak)
      if (s.agent !== AGENT_ID) {
        results.push({ step: i, skipped: true, reason: "not for this agent" });
        continue;
      }
      const mcpResult = await mcpCall(s.tool, s.arguments ?? {});
      results.push({ step: i, agent: s.agent, tool: s.tool, mcp_result: mcpResult });
    }
    return { steps_completed: results.length, results };
  }

  if (task.type === "agent.invoke") {
    // Verifikasi: hanya untuk agen ini (sesuai kontrak, reject jika bukan)
    if (payload?.agent !== AGENT_ID) {
      throw new Error("task not for this agent");
    }
    const mcpResult = await mcpCall(payload.tool, payload.arguments ?? {});
    return { agent: payload.agent, tool: payload.tool, mcp_result: mcpResult };
  }

  throw new Error("unsupported task type: " + task.type);
}

console.log(`[${AGENT_ID}] polling agent started -> ${GATEWAY}`);
setInterval(() => {
  poll().catch((e) => console.error(`[${AGENT_ID}] poll error:`, (e as Error).message));
}, POLL_MS);
poll();
