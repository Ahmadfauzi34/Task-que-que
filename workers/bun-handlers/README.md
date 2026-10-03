# Bun Worker Handlers

Implementasi 5 operasi terdaftar Task-que-que untuk Bun worker.

## Operasi

1. **hash.compute** — SHA-256 dari input string
2. **vector.dot** — Dot product dua vektor
3. **document.process** — Word count, line count, dll
4. **agent.invoke** — Single MCP call ke agen (`{agent, tool, arguments}`)
5. **workflow.run** — Multi-step MCP orchestration (`{steps: [{agent, tool, arguments}]}`)

## Cara Pakai

```bash
# Di Termux, setelah install:
cd ~/tqq/workers
# worker.ts = template worker (claim dari broker/SQLite)
# worker-handlers.ts = file ini (5 handler)

# Jalankan worker untuk semua operasi:
bun worker.ts worker-1 "hash.compute,vector.dot,document.process,agent.invoke,workflow.run"

# Atau spesifik untuk MCP saja:
TQQ_AGENTS_JSON='{"nama-agen":"http://host/mcp"}' \
  bun worker.ts worker-mcp "agent.invoke,workflow.run"
```

## Konfigurasi MCP

`TQQ_AGENTS_JSON`: map nama agen → URL MCP server-nya.
```json
{
  "dummy-agent": "http://127.0.0.1:18080/",
  "sandbox-agent": "http://192.168.1.10:18090/"
}
```
