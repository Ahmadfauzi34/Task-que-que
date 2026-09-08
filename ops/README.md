# Termux reference machine lifecycle

`termux-reference-machine.sh` is the reference lifecycle boundary for the persistent Android/Termux deployment. It does not replace the queue, gateway, broker, or workers with a second supervisor implementation; it only starts and verifies the existing bounded components in dependency order.

```text
Cloudflare Quick Tunnel
        |
        v
Bun Gateway 127.0.0.1:3000
        |
        v
Rust Queue 127.0.0.1:7331
        ^
        |
Rust Worker Broker 127.0.0.1:7332
   |          |          |
   v          v          v
CPU worker  Workflow   Vector
```

The queue database, gateway bearer token, logs, result artifacts, lifecycle pid records, and current Quick Tunnel URL live under `${TASK_QUEUE_DATA_DIR:-$HOME/.task-queue}`. `restart` never deletes the database, token, logs, or result artifacts.

## Commands

```sh
sh ops/termux-reference-machine.sh start
sh ops/termux-reference-machine.sh status
sh ops/termux-reference-machine.sh restart
sh ops/termux-reference-machine.sh stop
```

`start` is dependency-aware and verifies each transition before continuing:

```text
queue ready
  -> gateway ready
  -> broker ready
  -> CPU worker registered
  -> workflow worker registered
  -> vector worker registered
  -> optional remote-agent worker registered
  -> Cloudflare URL captured
  -> public /readyz reachable (default)
```

If a lifecycle pid file is stale or its PID now belongs to a different command, the record is cleared without signalling that process. If a matching process or loopback endpoint exists without a valid lifecycle pid record, `start` refuses to attach to it as an unmanaged process instead of silently trusting stale state.

`stop` sends `SIGINT` first and works in reverse dependency order. It only signals a PID when the current `/proc/<pid>/cmdline` still matches the component recorded by the lifecycle layer. `SIGTERM` and finally `SIGKILL` are bounded fallbacks.

`status` verifies live processes and the three localhost readiness endpoints instead of treating pid files as proof. Worker status also requires the expected registration line in the persistent log. With the default public probe enabled it verifies the saved Quick Tunnel URL through `/readyz` as well.

## Runtime paths and secrets

Default state layout:

```text
$HOME/.task-queue/
├── queue.db
├── gateway-token          # mode 0600; never printed by the lifecycle script
├── public-url             # current temporary Quick Tunnel hostname
├── pids/
├── logs/
└── results/
    ├── document/
    ├── workflow/
    ├── vector/
    └── remote-agent/
```

The Quick Tunnel hostname is transport state, not identity or authorization. It can change after `cloudflared` restarts. The Bun bearer token remains the public API authority and is persisted independently of the tunnel hostname.

The Rust queue and worker broker remain loopback-only. Never publish ports `7331` or `7332` directly.

## Binary overrides

Defaults:

```text
TASK_QUEUE_RUST_BIN        $HOME/.local/bin/robust-sinkhorn-queue
TASK_QUEUE_WORKER_BIN      $HOME/.local/bin/robust-sinkhorn-worker
TASK_QUEUE_BUN_BIN         $HOME/.local/bin/task-queue-bun
TASK_QUEUE_CLOUDFLARED_BIN cloudflared
```

Development or exact-artifact proof can point at reviewed binaries without changing lifecycle logic:

```sh
TASK_QUEUE_RUST_BIN="$HOME/pr36-bin/robust-sinkhorn-queue-aarch64-linux-android" \
TASK_QUEUE_WORKER_BIN="$HOME/pr36-bin/robust-sinkhorn-worker-aarch64-linux-android" \
TASK_QUEUE_BUN_BIN="$HOME/.local/bin/task-queue-bun" \
sh ops/termux-reference-machine.sh start
```

Other controls:

```text
TASK_QUEUE_DATA_DIR
TASK_QUEUE_ROOT_DIR
TASK_QUEUE_ENABLE_TUNNEL=0|1          default 1
TASK_QUEUE_PUBLIC_READY_PROBE=0|1     default 1
TASK_QUEUE_ENABLE_REMOTE_AGENT=0|1    default 0
```

Remote-agent execution is intentionally not enabled by default because it introduces an external provider boundary. When explicitly enabled, the existing `REMOTE_AGENT_*` environment variables are inherited by the worker; the lifecycle layer does not invent a provider or broaden the worker capability.

For a local-only machine, set `TASK_QUEUE_ENABLE_TUNNEL=0`. This leaves the same queue/gateway/broker/worker topology intact without claiming public reachability.

## CI proof versus physical proof

`tests/reference-machine-lifecycle-smoke.sh` exercises the lifecycle with the real Linux queue, broker, gateway, and Bun workers while replacing only Cloudflare transport with a bounded fake tunnel. It proves start/status/restart, persistent bearer authority, durable task/result recovery, worker registration, stale-pid recovery, and URL capture.

Physical Android proof remains a separate obligation. On Termux, run the lifecycle with the reviewed Android ARM64 queue/broker artifacts and the project-scoped Bun launcher, then validate:

```sh
sh ops/termux-reference-machine.sh status
cat "$HOME/.task-queue/public-url"
```

A later Termux:Boot integration should call this same lifecycle entrypoint. Boot automation is a consumer of the reference machine, not a second source of startup truth.
