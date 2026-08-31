# Bun Gateway V1

This directory is a public-facing policy boundary for the Rust queue daemon.

```text
Cloudflare Tunnel
      |
      v
Bun Gateway 127.0.0.1:3000
      |
      v
Rust Queue API 127.0.0.1:7331
      |
      v
fenced queue + SQLite
```

The gateway never opens `queue.db` and callers never send internal `X-Task-*` headers directly.

## Security model

The gateway is intentionally fail-closed:

- it only binds to numeric loopback (`127.0.0.1` or `::1`)
- the Rust daemon origin must also be numeric loopback HTTP
- task routes require `Authorization: Bearer ...` by default
- unauthenticated mode requires the explicit `GATEWAY_ALLOW_UNAUTHENTICATED=1` override
- public request bodies are capped at 1 MiB by `Bun.serve`
- task types must exist in `src/registry.ts`
- the caller cannot choose the internal queue/worker kind
- task query responses are reconstructed from an allowlist and never proxy arbitrary Rust fields such as payload

`document.process -> cpu` is the initial reference registration. Add new task types by reviewing and extending `src/registry.ts` rather than accepting arbitrary task names from the network.

## Run

The Rust daemon must already be running:

```sh
robust-sinkhorn-queue serve --db "$HOME/.task-queue/queue.db"
```

Then start the gateway:

```sh
cd gateway
export GATEWAY_API_TOKEN='replace-with-a-long-random-secret'
bun run start
```

Defaults:

```text
Gateway        http://127.0.0.1:3000
Rust daemon    http://127.0.0.1:7331
```

Optional configuration:

```text
GATEWAY_HOST                 default 127.0.0.1; loopback only
GATEWAY_PORT                 default 3000
QUEUE_DAEMON_URL             default http://127.0.0.1:7331; loopback only
GATEWAY_API_TOKEN            required by default
GATEWAY_ALLOW_UNAUTHENTICATED=1 explicit local-development bypass
GATEWAY_UPSTREAM_TIMEOUT_MS  default 3000, bounded to 100..30000
```

## Public API

Gateway liveness:

```sh
curl http://127.0.0.1:3000/healthz
```

Combined gateway + Rust readiness:

```sh
curl http://127.0.0.1:3000/readyz
```

Create a registered task:

```sh
curl -X POST http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer $GATEWAY_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "type":"document.process",
    "payload":{"document_id":"abc"},
    "priority":10,
    "max_retries":3
  }'
```

The gateway translates that request to the private Rust contract:

```text
X-Task-Name: document.process
X-Task-Type: cpu
X-Task-Priority: 10
X-Task-Max-Retries: 3
body: {"document_id":"abc"}
```

Query task state:

```sh
curl http://127.0.0.1:3000/v1/tasks/1 \
  -H "Authorization: Bearer $GATEWAY_API_TOKEN"
```

## Validation

```sh
bun test
bun build src/server.ts --target=bun --outdir=.check-dist
```

V1 deliberately does not yet expose Cloudflare configuration, arbitrary shell execution, worker registration, or an idempotency contract. Those remain separate boundaries rather than being hidden inside the first gateway implementation.
