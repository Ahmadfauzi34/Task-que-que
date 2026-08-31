# Termux deployment without compiling Rust

This project can be deployed to a 64-bit Android/Termux device without installing Rust or Cargo on the device.

## Deployment model

Rust compilation happens in GitHub Actions. Termux only receives the resulting Android ARM64 executable.

```text
GitHub repository
      |
      v
GitHub Actions (Ubuntu + Android NDK)
      |
      v
aarch64-linux-android release binary
      |
      +--> workflow artifact for CI/manual runs
      |
      +--> GitHub Release asset for v* tags
      |
      v
Android / Termux
      |
      v
checksum + chmod +x + run
```

## Supported first target

The initial deployment target is:

```text
aarch64-linux-android
```

On the Termux device, verify the architecture:

```sh
uname -m
```

Expected output for this binary:

```text
aarch64
```

## One-line install from the latest Release

Once a tagged GitHub Release exists, Termux installation can be done without Rust/Cargo/NDK:

```sh
pkg install -y curl coreutils
curl -fsSL https://raw.githubusercontent.com/Ahmadfauzi34/Task-que-que/main/install-termux.sh | sh
```

The installer:

- accepts only Android ARM64 (`aarch64`/`arm64`) for the current release target
- downloads the binary and `.sha256` from the latest GitHub Release
- verifies SHA256 before installation
- installs the executable to `$HOME/.local/bin/robust-sinkhorn-queue`
- creates `$HOME/.task-queue`
- runs `version` and `doctor` as post-install checks
- does not install Rust, Cargo, a C compiler, or the Android NDK

Install a specific release instead of `latest`:

```sh
curl -fsSL https://raw.githubusercontent.com/Ahmadfauzi34/Task-que-que/main/install-termux.sh \
  | TASK_QUEUE_VERSION=v0.1.0 sh
```

Custom install/data directories are also supported through `TASK_QUEUE_INSTALL_DIR` and `TASK_QUEUE_DATA_DIR`.

## Manual install from a tagged GitHub Release

Replace `<version>` with a published tag such as `v0.1.0`.

```sh
pkg install -y curl coreutils
mkdir -p "$HOME/tmp/robust-queue-install" "$HOME/.local/bin"
cd "$HOME/tmp/robust-queue-install"

curl -fLO \
  "https://github.com/Ahmadfauzi34/Task-que-que/releases/download/<version>/robust-sinkhorn-queue-aarch64-linux-android"

curl -fLO \
  "https://github.com/Ahmadfauzi34/Task-que-que/releases/download/<version>/robust-sinkhorn-queue-aarch64-linux-android.sha256"

sha256sum -c robust-sinkhorn-queue-aarch64-linux-android.sha256
chmod +x robust-sinkhorn-queue-aarch64-linux-android
mv robust-sinkhorn-queue-aarch64-linux-android "$HOME/.local/bin/robust-sinkhorn-queue"
```

Add the user binary directory to PATH if needed:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

## Install from a GitHub Actions artifact

The `Android Termux Binary` workflow uploads an artifact named:

```text
robust-sinkhorn-queue-termux-arm64
```

It contains:

```text
robust-sinkhorn-queue-aarch64-linux-android
robust-sinkhorn-queue-aarch64-linux-android.sha256
```

Artifacts are intended for CI validation and development builds. Tagged GitHub Releases are the preferred distribution path for stable versions.

## Runtime commands

Running the binary with no arguments is intentionally safe and only prints help:

```sh
robust-sinkhorn-queue
```

Check version:

```sh
robust-sinkhorn-queue version
```

Validate that the runtime can create/open the database and ensure the schema:

```sh
mkdir -p "$HOME/.task-queue"
robust-sinkhorn-queue doctor --db "$HOME/.task-queue/queue.db"
```

Expected shape:

```text
status   : ok
version  : 0.1.0
os       : android
arch     : aarch64
database : .../.task-queue/queue.db
schema   : ready
```

Run the persistent maintenance daemon and localhost API:

```sh
robust-sinkhorn-queue serve --db "$HOME/.task-queue/queue.db"
```

The default API bind is deliberately loopback-only:

```text
127.0.0.1:7331
```

`serve` owns schema/lease maintenance plus a small internal HTTP API intended for a same-device gateway such as Bun. It does **not** execute arbitrary task payloads and it refuses non-loopback `--listen` addresses. Public traffic should terminate at the Bun/Cloudflare layer rather than at this Rust API.

Example startup:

```text
robust-sinkhorn-queue 0.1.0
mode                 : serve
database             : .../.task-queue/queue.db
maintenance interval : 2000 ms
network API          : http://127.0.0.1:7331 (loopback only)
health               : http://127.0.0.1:7331/healthz
readiness            : http://127.0.0.1:7331/readyz
status               : ready
press Ctrl+C to stop
```

Stop it with `Ctrl+C`.

## Local API contract

Health and readiness:

```sh
curl -sS http://127.0.0.1:7331/healthz
curl -sS http://127.0.0.1:7331/readyz
```

Enqueue a task. Metadata is carried by internal `X-Task-*` headers while the request body is stored as the opaque UTF-8 payload:

```sh
curl -sS -X POST http://127.0.0.1:7331/v1/tasks \
  -H 'X-Task-Name: document.process' \
  -H 'X-Task-Type: cpu' \
  -H 'X-Task-Priority: 10' \
  -H 'X-Task-Max-Retries: 3' \
  --data-binary '{"document_id":"abc"}'
```

Expected response shape:

```json
{"task_id":1,"status":"PENDING"}
```

Read a task snapshot without exposing SQLite directly:

```sh
curl -sS http://127.0.0.1:7331/v1/tasks/1
```

The snapshot intentionally excludes the task payload. It exposes queue state, retry counters, lease timestamps, owner (when present), and lease generation for operational inspection.

Current local API boundaries:

```text
GET  /healthz
GET  /readyz
POST /v1/tasks
GET  /v1/tasks/<id>
```

The HTTP implementation limits headers to 16 KiB, payload bodies to 1 MiB, closes each connection after one response, rejects transfer-encoding/chunked requests, and applies request/response I/O timeouts. These constraints keep the internal daemon protocol bounded while Bun remains the richer external API surface.

## Bun boundary

The intended topology is:

```text
Internet
   |
   v
Cloudflare Tunnel
   |
   v
Bun gateway (public API, auth, rate limits, validation)
   |
   v
127.0.0.1:7331
   |
   v
Rust queue daemon
   |
   v
SQLite queue.db
```

Bun should never open `queue.db` directly. It should enqueue/query through the localhost contract so queue invariants, lease fencing, and future migrations stay owned by Rust.

For a self-contained functional demonstration of enqueue -> dispatch -> worker execution -> completion, use a separate demo database:

```sh
robust-sinkhorn-queue demo --db "$HOME/.task-queue/demo.db"
```

The `demo` command is deliberately separated from `serve` so the production daemon never marks real tasks complete using a simulated handler.

## What is intentionally not required on Termux

The runtime device does **not** need:

```text
rustc
cargo
Android NDK
C compiler
project source tree
Cargo registry/cache
```

The only project runtime files are the executable and data files it creates, such as `queue.db`.

## Release flow

Normal CI/manual run:

```text
push / pull request / workflow_dispatch
                |
                v
      build Android ARM64
                |
                v
       Actions artifact
```

Stable release:

```text
git tag vX.Y.Z
      |
      v
push tag
      |
      v
Android ARM64 build
      |
      v
GitHub Release assets
      |
      v
curl installer resolves latest release
```

## Validation boundary

The Android ARM64 artifact path has now been validated both in GitHub Actions and on a real Termux ARM64 device:

```text
SHA256 verification       OK
AArch64 ELF               OK
/system/bin/linker64      OK
Android 21 target         OK
process execution         OK
SQLite database creation  OK
queue task processing     OK
graceful shutdown         OK
exit code                 0
```

This proves the tested Android/Termux ARM64 path works without a Rust toolchain on the device. It does not imply that every Android version, vendor ROM, CPU architecture, or Termux environment is supported.
