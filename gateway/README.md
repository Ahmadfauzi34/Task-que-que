# Bun Gateway

This directory is the public-facing policy boundary for the Rust queue daemon.

```text
Cloudflare Tunnel (future boundary)
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

## Security and admission model

The gateway is intentionally fail-closed:

- it only binds to numeric loopback (`127.0.0.1` or `::1`)
- the Rust daemon origin must also be numeric loopback HTTP
- task routes require `Authorization: Bearer ...` by default
- unauthenticated mode requires the explicit `GATEWAY_ALLOW_UNAUTHENTICATED=1` override
- public request bodies are capped at 1 MiB by `Bun.serve`
- task types must exist in `src/registry.ts`
- the caller cannot choose the internal queue/worker kind
- every public task creation requires a bounded `Idempotency-Key`
- valid enqueue requests pass through a configurable token-bucket admission limit before Rust/SQLite
- task query responses are reconstructed from an allowlist and never proxy arbitrary Rust fields such as payload

`document.process -> cpu` is the initial reference registration. Add new task types by reviewing and extending `src/registry.ts` rather than accepting arbitrary task names from the network.

The rate limiter is deliberately a **global gateway admission bound**, not a claimed end-user identity limiter. When Cloudflare identity is introduced, identity-aware quotas can be layered in front without weakening this machine-level bound.

## Durable idempotency

Idempotency is not implemented as a Bun memory cache. That would leave a crash window where Rust commits a task, Bun dies before caching the response, and a retry creates a duplicate.

Instead the gateway canonicalizes the effective task contract and computes a SHA-256 fingerprint over:

```text
contract version
public task type
registry-selected queue kind
effective priority
effective max_retries
canonical JSON payload
```

It passes the public key and fingerprint over the private loopback protocol. Rust performs the dedupe decision in SQLite under the same `BEGIN IMMEDIATE` transaction that inserts the task:

```text
same key + same fingerprint
    -> return the original task_id (replay)

same key + different fingerprint
    -> HTTP 409 conflict

new key
    -> INSERT task + idempotency record atomically
```

The mapping is stored in the additive `task_idempotency` table, so replay survives Bun or Rust process restarts. The old localhost enqueue form remains additive-compatible: when both private idempotency headers are absent, Rust performs the legacy non-idempotent enqueue. The Bun public API always uses the durable path.

## Termux: native Bun Android runtime

Bun 1.4.0 publishes an official Android ARM64/Bionic release asset named `bun-linux-aarch64-android.zip`. The gateway therefore does not require a glibc wrapper or a community Bun build on supported ARM64 Android devices.

Install the pinned runtime without replacing any existing `bun` command:

```sh
pkg install -y curl coreutils unzip
curl -fsSL https://raw.githubusercontent.com/Ahmadfauzi34/Task-que-que/main/gateway/install-bun-termux.sh | sh
```

The installer:

- accepts Android ARM64 only
- downloads from the official `oven-sh/bun` GitHub release
- verifies the pinned SHA256 before extraction
- executes the downloaded binary before installation
- installs it under `~/.local/lib/task-queue-bun/<version>/bun`
- exposes only the project-scoped launcher `~/.local/bin/task-queue-bun`

For versions other than the pinned default, an explicit official asset digest is required through `TASK_QUEUE_BUN_SHA256`. This keeps upgrades fail-closed instead of silently trusting a changed download.

Bun on Android is still a newer execution target than desktop Linux. Physical-device validation remains part of the deployment proof, especially across Android kernels/seccomp policies.

## Run

The Rust daemon must already be running:

```sh
robust-sinkhorn-queue serve --db "$HOME/.task-queue/queue.db"
```

Then start the gateway. On ordinary Bun installations:

```sh
cd gateway
export GATEWAY_API_TOKEN='replace-with-a-long-random-secret'
bun run start
```

With the project-scoped Termux runtime installed above:

```sh
cd gateway
export GATEWAY_API_TOKEN='replace-with-a-long-random-secret'
task-queue-bun run src/server.ts
```

Defaults:

```text
Gateway        http://127.0.0.1:3000
Rust daemon    http://127.0.0.1:7331
```

Optional configuration:

```text
GATEWAY_HOST                     default 127.0.0.1; loopback only
GATEWAY_PORT                     default 3000
QUEUE_DAEMON_URL                 default http://127.0.0.1:7331; loopback only
GATEWAY_API_TOKEN                required by default
GATEWAY_ALLOW_UNAUTHENTICATED=1  explicit local-development bypass
GATEWAY_UPSTREAM_TIMEOUT_MS      default 3000, bounded to 100..30000
GATEWAY_ENQUEUE_RATE_PER_SECOND  default 10, bounded to 1..10000
GATEWAY_ENQUEUE_BURST            default 20, bounded to 1..100000
```

These are reference defaults rather than a claim that every device should use the same throughput. Tune them from measured device capacity while keeping a finite bound.

## Physical Termux proof

CI proves the protocol on Linux, but Android execution is a separate proof obligation. After both `robust-sinkhorn-queue` and the project-scoped `task-queue-bun` launcher matching the tested branch are installed, run the isolated physical-device smoke test from a repository checkout:

```sh
sh gateway/tests/termux-smoke.sh
```

The smoke proof owns ports `127.0.0.1:7331` and `127.0.0.1:3000`. It refuses to run if an existing queue daemon or gateway is already serving on those ports, so it cannot accidentally pass by attaching to a stale process.

It starts both processes with a temporary queue database, then proves:

- Android ARM64 and `/system/bin/linker64`
- the installed Rust queue binary executes
- the installed Bun Android runtime executes
- Rust readiness
- Bun -> Rust combined readiness
- unauthenticated task creation is rejected with HTTP 401
- authenticated creation without `Idempotency-Key` is rejected
- first idempotent enqueue creates a task
- same key + same request returns the same `task_id`
- same key + changed request returns HTTP 409
- replay does not create task 2
- the registry maps `document.process -> cpu`
- task query does not disclose payload
- SQLite state is actually created

The temporary processes and database are removed on exit. The script does not replace the persistent production database.

If commands live outside `PATH`, point the proof at exact binaries without changing its logic:

```sh
TASK_QUEUE_RUST_BIN="$HOME/.local/bin/robust-sinkhorn-queue" \
TASK_QUEUE_BUN_BIN="$HOME/.local/bin/task-queue-bun" \
sh gateway/tests/termux-smoke.sh
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

Create a registered task. Generate a new idempotency key for each logical operation, and reuse that same key when retrying that operation:

```sh
IDEMPOTENCY_KEY="document-abc-$(date +%s)"

curl -X POST http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer $GATEWAY_API_TOKEN" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "type":"document.process",
    "payload":{"document_id":"abc"},
    "priority":10,
    "max_retries":3
  }'
```

First acceptance:

```json
{"task_id":1,"status":"PENDING","replayed":false}
```

A retry with the same key and equivalent effective request returns the original task:

```json
{"task_id":1,"status":"PENDING","replayed":true}
```

Reusing that key for a different effective task request returns HTTP `409`. A request above the configured admission rate returns HTTP `429` with `Retry-After`; retry it later using the **same** `Idempotency-Key`.

The gateway translates the accepted request to the private Rust contract:

```text
X-Task-Name: document.process
X-Task-Type: cpu
X-Task-Priority: 10
X-Task-Max-Retries: 3
X-Idempotency-Key: <validated public key>
X-Request-Fingerprint: <canonical SHA-256>
body: {"document_id":"abc"}
```

Query current task state:

```sh
curl http://127.0.0.1:3000/v1/tasks/1 \
  -H "Authorization: Bearer $GATEWAY_API_TOKEN"
```

The `PENDING` value in an idempotent replay response is the original enqueue acknowledgement. Use `GET /v1/tasks/:id` for current state.

## Validation

```sh
bun test
bun build src/server.ts --target=bun --outdir=.check-dist
```

Repository CI additionally runs Rust format/Clippy/tests and the real Bun -> Rust localhost integration. The Android workflow cross-builds the Rust binary for Termux. Physical Android execution remains an explicit proof step after changes that affect the Android runtime path.

Cloudflare Tunnel configuration, external identity mapping, arbitrary shell execution, and worker registration remain separate boundaries. They are not hidden inside this hardening layer.
