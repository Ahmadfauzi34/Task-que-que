# tqq-connector (JavaScript/TypeScript)

JavaScript/TypeScript client untuk Task-que-que polling agents.

## Install

```bash
npm install git+https://github.com/Ahmadfauzi34/Task-que-que.git#subdirectory=connectors/javascript
```

Atau dengan Bun:
```bash
bun add git+https://github.com/Ahmadfauzi34/Task-que-que.git#subdirectory=connectors/javascript
```

## Pakai

```typescript
import { Agent } from "tqq-connector";

const agent = new Agent({
  gatewayUrl: "http://<hp>:3100",
  agentId: "my-agent",
  mcpUrl: "http://127.0.0.1:18090",  // MCP server lokal
});

await agent.serve();  // Poll -> eksekusi -> lapor
```

## API

### `new Agent(opts)`
- `gatewayUrl`: URL gateway Task-que-que
- `agentId`: ID unik agen ini
- `mcpUrl`: URL MCP server lokal
- `pollTimeout`: timeout poll dalam detik (default: 30)
- `heartbeatInterval`: interval heartbeat dalam ms (default: 30000)

### `agent.serve()`
Mulai polling loop. Handle SIGINT/SIGTERM untuk stop graceful.

### `agent.start()` / `agent.stop()`
Kontrol manual tanpa signal handler.

## Contoh

Lihat `examples/` untuk contoh lengkap.
