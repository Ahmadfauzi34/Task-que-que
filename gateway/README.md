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
GATEWAY_HOST                 default 127.0.0.1; loopback only
GATEWAY_PORT                 default 3000
QUEUE_DAEMON_URL             default http://127.0.0.1:7331; loopback only
GATEWAY_API_TOKEN            required by default
GATEWAY_ALLOW_UNAUTHENTICATED=1 explicit local-development bypass
GATEWAY_UPSTREAM_TIMEOUT_MS  default 3000, bounded to 100..30000
```

## Physical Termux proof

CI proves the protocol on Linux, but Android execution is a separate proof obligation. After both `robust-sinkhorn-queue` and the project-scoped `task-queue-bun` launcher are installed, run the isolated physical-device smoke test from a repository checkout:

```sh
pkg install -y git curl
cd "$HOME"

git clone https://github.com/Ahmadfauzi34/Task-que-que.git 2>/dev/null || true
cd Task-que-que
git pull --ff-only

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
- authenticated `document.process` enqueue reaches Rust/SQLite
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
