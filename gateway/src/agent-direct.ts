/**
 * Agent Direct: claim/complete via SQLite langsung (tanpa broker).
 * Untuk agen polling eksternal yang tidak bisa akses broker.
 */

import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

// In-memory agent presence: agent_id -> {last_seen, mcp_tools, agent_type}
const agentPresence = new Map<string, {
  last_seen: number;
  mcp_tools: string[];
  agent_type: string;
}>();

// Agent tokens: agent_id -> token (in-memory, agents re-register after restart)
const agentTokens = new Map<string, string>();

function verifyAgentToken(request: Request, agentId: string): boolean {
  const token = request.headers.get("x-agent-token");
  if (!token || !agentId) return false;
  return agentTokens.get(agentId) === token;
}

const DB_PATH = join(homedir(), "tqq", "queue.db");

export async function handleAgentDirectRequest(
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/v1/agent/poll" && request.method === "POST") {
    const _body = await request.clone().json().catch(() => ({}));
    if (!verifyAgentToken(request, _body.agent_id)) {
      return Response.json({ error: "invalid agent token" }, { status: 401 });
    }
    const body = await request.json().catch(() => ({}));
    const agentId = body.agent_id as string;
    if (!agentId) {
      return Response.json({ error: "agent_id required" }, { status: 400 });
    }

    const db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL;");

    // Auto-release: kembalikan task CLAIMED yang lease-nya expired
    // (agen mati/crash setelah claim tapi sebelum lapor)
    const now = Date.now() / 1000;
    const released = db.query(`
      UPDATE tasks SET status = 'PENDING', locked_by = NULL, locked_until = NULL
      WHERE status = 'CLAIMED' AND locked_until IS NOT NULL AND locked_until < ?
    `).run(now);
    if (released.changes > 0) {
      console.log(`[agent-direct] auto-released ${released.changes} expired task(s)`);
    }

    // Claim satu task PENDING untuk workflow.run/agent.invoke
    // yang steps-nya menargetkan agent ini (cek sederhana via payload)
    const task = db.query(`
      UPDATE tasks SET status = 'CLAIMED', locked_by = ?, locked_until = ?
      WHERE id = (
        SELECT id FROM tasks
        WHERE status = 'PENDING'
          AND task_name IN ('workflow.run', 'agent.invoke')
          AND scheduled_at <= ?
        ORDER BY priority DESC, id ASC
        LIMIT 1
      )
      RETURNING id, task_name, payload
    `).get(agentId, Date.now() / 1000 + 60, Date.now() / 1000) as any;

    db.close();

    if (!task) {
      return new Response(null, { status: 204 });
    }

    // Filter: hanya untuk agent ini (cek payload)
    try {
      const payload = JSON.parse(task.payload);
      const targetsThisAgent =
        (task.task_name === "workflow.run" &&
          payload?.steps?.some((s: any) => s.agent === agentId)) ||
        (task.task_name === "agent.invoke" && payload?.agent === agentId);

      if (!targetsThisAgent) {
        // Kembalikan ke PENDING
        const db2 = new Database(DB_PATH);
        db2.query(`UPDATE tasks SET status = 'PENDING', locked_by = NULL, locked_until = NULL WHERE id = ?`).run(task.id);
        db2.close();
        return new Response(null, { status: 204 });
      }
    } catch {
      // payload invalid, kembalikan
      const db2 = new Database(DB_PATH);
      db2.query(`UPDATE tasks SET status = 'PENDING', locked_by = NULL, locked_until = NULL WHERE id = ?`).run(task.id);
      db2.close();
      return new Response(null, { status: 204 });
    }

    return Response.json({
      task: { id: task.id, type: task.task_name, payload_json: task.payload },
    });
  }

  if (url.pathname === "/v1/agent/result" && request.method === "POST") {
    // Verifikasi via task ownership (task harus di-claim oleh agen ini)
    // Untuk sederhana: cek header X-Agent-Id + token
    const _aid = request.headers.get("x-agent-id");
    if (!verifyAgentToken(request, _aid || "")) {
      return Response.json({ error: "invalid agent token" }, { status: 401 });
    }
    const body = await request.json().catch(() => ({}));
    const { task_id, result, error } = body as any;
    if (!task_id) {
      return Response.json({ error: "task_id required" }, { status: 400 });
    }

    const db = new Database(DB_PATH);
    const status = error ? "FAILED" : "COMPLETED";
    db.query(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, task_id);
    const resultStr = JSON.stringify(error ? { error } : result);
    const resultBytes = Buffer.from(resultStr, "utf-8");
    db.query(`
      INSERT INTO task_results (task_id, result_json, result_bytes, lease_generation, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET result_json = excluded.result_json, result_bytes = excluded.result_bytes
    `).run(
      task_id,
      resultStr,
      resultBytes,
      0,
      Date.now() / 1000,
    );
    db.close();

    return Response.json({ ok: true, status });
  }

  // Register: agen daftar dan dapat token unik
  if (url.pathname === "/v1/agent/register" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const { agent_id, agent_type } = body as any;
    if (!agent_id || typeof agent_id !== "string" || agent_id.length > 64) {
      return Response.json({ error: "valid agent_id required" }, { status: 400 });
    }
    // Generate token unik
    const token = randomBytes(32).toString("hex");
    agentTokens.set(agent_id, token);
    // Juga catat presence awal
    agentPresence.set(agent_id, {
      last_seen: Date.now() / 1000,
      mcp_tools: [],
      agent_type: agent_type || "unknown",
    });
    return Response.json({ ok: true, agent_id, agent_token: token });
  }

  // Heartbeat: agen lapor masih hidup + tools yang dimiliki
  if (url.pathname === "/v1/agent/heartbeat" && request.method === "POST") {
    const _hb = await request.clone().json().catch(() => ({}));
    if (!verifyAgentToken(request, _hb.agent_id)) {
      return Response.json({ error: "invalid agent token" }, { status: 401 });
    }
    const body = await request.json().catch(() => ({}));
    const { agent_id, mcp_tools, agent_type } = body as any;
    if (!agent_id) {
      return Response.json({ error: "agent_id required" }, { status: 400 });
    }
    agentPresence.set(agent_id, {
      last_seen: Date.now() / 1000,
      mcp_tools: Array.isArray(mcp_tools) ? mcp_tools : [],
      agent_type: agent_type || "unknown",
    });
    return Response.json({ ok: true, agent_id });
  }

  // List agen aktif (heartbeat < 90 detik)
  if (url.pathname === "/v1/agents" && request.method === "GET") {
    const now = Date.now() / 1000;
    const active: any[] = [];
    for (const [id, info] of agentPresence.entries()) {
      if (now - info.last_seen < 90) {
        active.push({
          agent_id: id,
          agent_type: info.agent_type,
          mcp_tools: info.mcp_tools,
          last_seen_ago_s: Math.round(now - info.last_seen),
        });
      } else {
        agentPresence.delete(id);  // bersihkan yang sudah mati
      }
    }
    return Response.json({ agents: active, count: active.length });
  }

  return null;
}
