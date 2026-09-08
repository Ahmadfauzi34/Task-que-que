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

## Termux:Boot adapter

Termux:Boot is an Android add-on that executes files from `~/.termux/boot/` after boot. Install Termux and Termux:Boot from compatible/trusted sources, then open the Termux:Boot launcher once so Android can deliver future boot events to it. The upstream project documents the same `~/.termux/boot/` directory and executes multiple boot files in filename order.

The Task-que-que integration deliberately keeps Termux:Boot as a consumer of the lifecycle boundary:

```text
Android BOOT_COMPLETED
        ↓
Termux:Boot
        ↓
~/.termux/boot/50-task-queue-reference-machine
        ↓
ops/termux-boot-entrypoint.sh
        ↓
ops/termux-reference-machine.sh
```

The boot adapter does not start queue/broker/workers directly and does not own stop/restart logic. It first asks the existing lifecycle to establish the local reference machine with public transport disabled. This keeps queue/gateway/broker/workers recoverable even when Android boots before Internet connectivity has returned. It then asks the same lifecycle to attach Cloudflare transport and separately waits for public readiness.

Install the adapter from the checkout that should become the boot reference:

```sh
TASK_QUEUE_RUST_BIN="$HOME/pr36-bin/robust-sinkhorn-queue-aarch64-linux-android" \
TASK_QUEUE_WORKER_BIN="$HOME/pr36-bin/robust-sinkhorn-worker-aarch64-linux-android" \
TASK_QUEUE_BUN_BIN="$HOME/.local/bin/task-queue-bun" \
sh ops/install-termux-boot.sh
```

The installer writes only a thin, marked adapter under `~/.termux/boot/`; it refuses to replace a file at that path that is not already one of its own marked adapters. The adapter records paths and bounded retry policy, never the gateway bearer token. Runtime evidence is appended to:

```text
$HOME/.task-queue/logs/boot.log
```

Boot-specific controls are references, not hidden platform claims:

```text
TASK_QUEUE_BOOT_ENABLE_TUNNEL=0|1          default 1
TASK_QUEUE_BOOT_WAKE_LOCK=0|1              default 0
TASK_QUEUE_BOOT_TUNNEL_ATTEMPTS            default 6, max 360
TASK_QUEUE_BOOT_TUNNEL_DELAY_SECONDS       default 5, max 300
TASK_QUEUE_BOOT_PUBLIC_ATTEMPTS            default 60, max 600
TASK_QUEUE_BOOT_PUBLIC_DELAY_SECONDS       default 2, max 300
TASK_QUEUE_BOOT_DIR                        default $HOME/.termux/boot
TASK_QUEUE_BOOT_SCRIPT_NAME                default 50-task-queue-reference-machine
```

`TASK_QUEUE_BOOT_WAKE_LOCK=1` requests `termux-wake-lock` when that command is available. Failure to acquire it is logged and is not misreported as success. Power-management policy remains an Android/device concern rather than a queue invariant.

The reference CI smoke test uses a fake lifecycle only to prove the adapter boundary: local-first invocation, bounded tunnel retry, public-readiness convergence, deterministic reinstall, and that no bearer secret is baked into the boot file. A real Android reboot remains the proof obligation for BOOT_COMPLETED delivery and vendor-specific background behavior.

After installing Termux:Boot, opening it once, and installing this adapter, the physical proof is:

```text
Android reboot
  -> Termux:Boot invokes adapter
  -> local reference machine READY
  -> Cloudflare transport attaches when connectivity permits
  -> public /readyz READY
  -> queue.db and gateway-token preserved
```

Do not infer reboot survival merely from CI or a manual invocation of the boot script. Only an observed Android reboot closes that proof.
