/**
 * Agent Direct: claim/complete via SQLite langsung (tanpa broker).
 * Untuk agen polling eksternal yang tidak bisa akses broker.
 */

import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";

const DB_PATH = join(homedir(), "tqq", "queue.db");

export async function handleAgentDirectRequest(
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/v1/agent/poll" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const agentId = body.agent_id as string;
    if (!agentId) {
      return Response.json({ error: "agent_id required" }, { status: 400 });
    }

    const db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL;");

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
    const body = await request.json().catch(() => ({}));
    const { task_id, result, error } = body as any;
    if (!task_id) {
      return Response.json({ error: "task_id required" }, { status: 400 });
    }

    const db = new Database(DB_PATH);
    const status = error ? "FAILED" : "COMPLETED";
    db.query(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, task_id);
    db.query(`
      INSERT INTO task_results (task_id, result_json, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET result_json = excluded.result_json
    `).run(
      task_id,
      JSON.stringify(error ? { error } : result),
      Date.now() / 1000,
    );
    db.close();

    return Response.json({ ok: true, status });
  }

  return null;
}
