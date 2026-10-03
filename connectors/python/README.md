# tqq-connector

Python client library untuk Task-que-que polling agents.

## Instalasi

```bash
pip install -e .  # dari direktori ini
# atau copy tqq_connector/ ke project-mu (tanpa dependencies eksternal!)
```

Tidak ada dependencies — hanya Python stdlib.

## Penggunaan

```python
from tqq_connector import Agent

agent = Agent(
    gateway_url="https://xxx.trycloudflare.com",
    token="capability-token-dari-hp",
    agent_id="nama-agen-unik",
    mcp_url="http://127.0.0.1:18090/",  # MCP server lokalmu
)
agent.serve()  # jalan terus: poll -> eksekusi -> lapor
```

## Cara Kerja

1. **Poll**: `POST /v1/agent/poll` tiap 2 detik (dengan exponential backoff saat gagal)
2. **Claim**: task dikunci atomik untuk agen ini
3. **Eksekusi**: setiap step `workflow.run` / `agent.invoke` dijalankan via MCP server lokal
4. **Lapor**: `POST /v1/agent/result` dengan hasil atau error

## MCP Server

Agen butuh MCP server lokal yang jalan. Contoh minimal (Bun):

```typescript
// mcp-server.ts
Bun.serve({
  port: 18090,
  async fetch(req) {
    const body = await req.json();
    if (body.method === "tools/list") {
      return Response.json({ jsonrpc: "2.0", id: body.id,
        result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
    }
    if (body.method === "tools/call") {
      return Response.json({ jsonrpc: "2.0", id: body.id,
        result: { content: [{ type: "text", text: "hello" }] } });
    }
    // ... initialize, notifications/initialized
  },
});
```

## Protokol

| Endpoint | Method | Fungsi |
|----------|--------|--------|
| `/v1/agent/poll` | POST | Ambil task (`{agent_id}`) → `{task}` atau 204 |
| `/v1/agent/result` | POST | Lapor hasil (`{task_id, result}` atau `{task_id, error}`) |
| `/v1/tasks` | POST | Submit task baru (opsional) |
| `/v1/tasks/:id` | GET | Cek status task |

Lease timeout: 60 detik. Task yang di-claim tapi tidak dilaporkan dalam 60 detik otomatis kembali PENDING.
