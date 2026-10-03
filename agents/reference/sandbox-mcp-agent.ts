/**
 * Sandbox MCP Agent Server
 *
 * MCP server custom yang berjalan di sandbox ini, diexpose via Cloudflare
 * tunnel agar bisa dipanggil oleh Task-que-que di HP via agent.invoke.
 *
 * Tools:
 *   - echo: kembalikan teks apa adanya
 *   - hitung: evaluasi ekspresi aritmetika sederhana (aman, tanpa eval)
 *   - waktu_jakarta: waktu saat ini di Asia/Jakarta
 */

const PORT = parseInt(process.env.MCP_PORT ?? "18090");

// Evaluator aritmetika aman (tanpa eval): hanya angka, +, -, *, /, (, ), spasi, titik
function hitungAman(expr: string): number {
  if (!/^[\d+\-*/().\s]+$/.test(expr)) {
    throw new Error("ekspresi mengandung karakter tak diizinkan");
  }
  // Tokenisasi sederhana dan evaluasi via Function dengan scope kosong.
  // Aman karena input sudah divalidasi hanya berisi karakter aritmetika.
  const clean = expr.trim();
  if (clean.length === 0 || clean.length > 200) {
    throw new Error("ekspresi kosong atau terlalu panjang");
  }
  const fn = new Function(`"use strict"; return (${clean});`);
  const result = fn();
  if (typeof result !== "number" || !isFinite(result)) {
    throw new Error("hasil bukan angka valid");
  }
  return result;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const body = (await req.json().catch(() => null)) as any;
    if (!body || body.jsonrpc !== "2.0") {
      return Response.json({
        jsonrpc: "2.0", id: body?.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      });
    }

    const id = body.id ?? null;

    if (body.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "sandbox-agent", version: "0.1.0" },
        },
      });
    }

    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (body.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0", id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Kembalikan teks apa adanya",
              inputSchema: {
                type: "object",
                properties: { teks: { type: "string" } },
                required: ["teks"],
              },
            },
            {
              name: "hitung",
              description: "Evaluasi ekspresi aritmetika sederhana",
              inputSchema: {
                type: "object",
                properties: { ekspresi: { type: "string" } },
                required: ["ekspresi"],
              },
            },
            {
              name: "waktu_jakarta",
              description: "Waktu saat ini di zona Asia/Jakarta",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      });
    }

    if (body.method === "tools/call") {
      const { name, arguments: args } = body.params ?? {};
      try {
        if (name === "echo") {
          const teks = String(args?.teks ?? "");
          return Response.json({
            jsonrpc: "2.0", id,
            result: { content: [{ type: "text", text: teks }] },
          });
        }
        if (name === "hitung") {
          const hasil = hitungAman(String(args?.ekspresi ?? ""));
          return Response.json({
            jsonrpc: "2.0", id,
            result: { content: [{ type: "text", text: String(hasil) }] },
          });
        }
        if (name === "waktu_jakarta") {
          const now = new Date().toLocaleString("id-ID", {
            timeZone: "Asia/Jakarta",
            dateStyle: "full",
            timeStyle: "long",
          });
          return Response.json({
            jsonrpc: "2.0", id,
            result: { content: [{ type: "text", text: now }] },
          });
        }
        return Response.json({
          jsonrpc: "2.0", id,
          error: { code: -32602, message: "Unknown tool: " + name },
        });
      } catch (e) {
        return Response.json({
          jsonrpc: "2.0", id,
          error: { code: -32000, message: (e as Error).message },
        });
      }
    }

    return Response.json({
      jsonrpc: "2.0", id,
      error: { code: -32601, message: "Method not found" },
    });
  },
});

console.log(`sandbox-agent MCP on :${PORT}`);
