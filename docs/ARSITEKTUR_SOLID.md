# Arsitektur Task-que-que + Agen MCP (Solid)

## Konsep Inti

HP sebagai **hub orkestrasi**, agen-agen di environment masing-masing terhubung via MCP.

```
[HP: Task-que-que]                          [Agen di environment lain]
  Gateway :3100  <--poll---                 polling-agent.ts
  Daemon  :7331  ---task-->                      |
  Broker  :7332  <--hasil--                      v
                                           MCP server lokal :18090
                                           (custom tools per agen)
```

## Dua Pola Konektivitas

### 1. Agen Reachable (HP memanggil agen)
- `workflow.run`: multi-step MCP orchestration
  - Payload: `{steps: [{agent, tool, arguments}]}`
  - Handler di HP bertindak sebagai MCP client
  - Setiap step = `tools/call` ke MCP server agen
- `agent.invoke`: single MCP call
  - Payload: `{agent, tool, arguments}`

### 2. Agen Non-Reachable / Client-Only (agen memanggil HP)
- **Polling agent**: agen poll HP tiap 2 detik
  - `POST /v1/agent/poll` → dapat task
  - Eksekusi via MCP server lokal
  - `POST /v1/agent/result` → lapor hasil
- Cocok untuk sandbox, environment di balik NAT, dll.

## Komponen yang Sudah Dibangun

### Di HP (`~/tqq/`)
- `gateway-pr66/src/agent-proxy.ts` — proxy broker API untuk agen eksternal
- `gateway-pr66/src/agent-direct.ts` — claim/complete via SQLite langsung
- `workers/worker-handlers.ts` — handler `workflow.run` (MCP orchestrator) & `agent.invoke` (MCP client)
- `bin/tqq-watchdog.sh` — supervisor auto-heal (gateway, daemon, broker)

### Di Sandbox (`~/workspace/tqq-e2e/`)
- `sandbox-mcp-agent.ts` — custom MCP server (tools: echo, hitung, waktu_jakarta)
- `polling-agent.ts` — agen polling (poll → eksekusi MCP lokal → lapor)

## Bukti yang Sudah Valid

1. ✅ `agent.invoke` via MCP: task 48, `{add, 5+7}` → `"12"` benar
2. ✅ Watchdog auto-heal: kill gateway → restart otomatis dalam ~15 detik
3. ✅ Termux stabil: tidak di-kill Android meski RAM kecil, baterai wajar, tidak panas
4. ✅ Agent proxy register: dapat session_token dari broker via gateway

## Yang Perlu Perhatian

- **RAM HP**: tetap monitor, jangan jalankan terlalu banyak Bun worker bersamaan
- **Gateway startup**: butuh `GATEWAY_API_TOKEN` dan `GATEWAY_PORT=3100` di env
- **Watchdog**: jalankan sekali via `bash ~/tqq/bin/tqq-watchdog.sh start` di Termux

## Cara Pakai Watchdog

```bash
# Di Termux (sekali saja):
bash ~/tqq/bin/tqq-watchdog.sh start   # mulai + auto-heal
bash ~/tqq/bin/tqq-watchdog.sh status  # cek semua layanan
bash ~/tqq/bin/tqq-watchdog.sh stop    # hentikan
```
