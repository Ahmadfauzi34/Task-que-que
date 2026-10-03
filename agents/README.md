# Agents Reference

Contoh implementasi agen untuk Task-que-que.

## polling-agent.ts

Agen polling untuk environment client-only (tidak bisa dihubungi langsung).

**Cara kerja:**
1. Poll `POST /v1/agent/poll` ke gateway HP tiap 2 detik
2. Dapat task `workflow.run` atau `agent.invoke`
3. Eksekusi steps via MCP server lokal
4. Lapor hasil via `POST /v1/agent/result`

**Cara pakai:**
```bash
TQQ_GATEWAY_URL="https://<tunnel>" \
TQQ_GATEWAY_TOKEN="<token>" \
TQQ_MCP_URL="http://127.0.0.1:18090/" \
TQQ_AGENT_ID="nama-agen" \
bun polling-agent.ts
```

## sandbox-mcp-agent.ts

Contoh custom MCP server dengan 3 tools:
- `echo` — kembalikan teks
- `hitung` — evaluasi aritmetika aman
- `waktu_jakarta` — waktu Asia/Jakarta

**Cara pakai:**
```bash
MCP_PORT=18090 bun sandbox-mcp-agent.ts
```

Ini adalah template — ganti tools sesuai kebutuhan agenmu.
