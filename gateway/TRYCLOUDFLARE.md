# TryCloudflare public reference path

This path is intentionally for a personal/reference machine, not a production service.

It uses Cloudflare Quick Tunnel (TryCloudflare) only as an outbound transport from the Android/Termux device to a temporary public HTTPS URL. Authentication remains owned by the Bun gateway.

```text
Internet client
    |
    | HTTPS + Authorization: Bearer <gateway token>
    v
random *.trycloudflare.com hostname
    |
    v
cloudflared on Termux
    | outbound tunnel only
    v
Bun Gateway 127.0.0.1:3000
    | bearer authentication
    | registry / bounded admission / durable idempotency contract
    v
Rust Queue API 127.0.0.1:7331
    v
SQLite + lease fencing + Sinkhorn scheduler
```

## Deliberate limitations

Quick Tunnel is a reference/development transport, not a production availability claim:

- the public hostname is random
- the hostname changes when the Quick Tunnel is restarted
- no uptime/SLA claim is made
- Cloudflare currently limits Quick Tunnels to 200 in-flight requests
- Server-Sent Events are not supported by Quick Tunnels

Those limits do not weaken the queue invariants. They only bound the transport used to demonstrate public reachability.

## Security boundary

No Cloudflare identity header is trusted.

The public authority remains the Bun bearer token. A request that reaches Bun without the correct bearer token must return HTTP 401 before it can enqueue work.

Rust and SQLite remain private:

- Bun binds only to numeric loopback (`127.0.0.1` or `::1`)
- Rust binds only to numeric loopback
- cloudflared points only at `http://127.0.0.1:3000`
- no inbound router/NAT port is opened on the Android device

The gateway's existing global token bucket remains the machine-level admission bound.

## Install cloudflared on Termux

```sh
pkg update
pkg install -y cloudflared
cloudflared --version
```

No Cloudflare account, domain, Access application, service token, card, or PayPal setup is required for a Quick Tunnel.

If `~/.cloudflared/config.yaml` or `~/.cloudflared/config.yml` already exists, move it aside before using Quick Tunnel. Cloudflare documents Quick Tunnels as incompatible with a local cloudflared configuration file.

## Manual transport check

With the Bun gateway already listening on `127.0.0.1:3000`:

```sh
cloudflared tunnel --url http://127.0.0.1:3000
```

cloudflared prints a temporary public URL similar to:

```text
https://random-words.trycloudflare.com
```

The URL is transport, not authentication. `/v1/tasks` still requires the Bun bearer token and `Idempotency-Key`.

## Physical proof harness

Use the dedicated script so Rust, Bun, SQLite and cloudflared are created as one isolated proof run:

```sh
TASK_QUEUE_RUST_BIN="$HOME/pr13-bin/robust-sinkhorn-queue-aarch64-linux-android" \
TASK_QUEUE_BUN_BIN="$HOME/.local/bin/task-queue-bun" \
sh gateway/tests/trycloudflare-smoke.sh
```

The script generates a temporary bearer token internally and does not print it.

It proves:

1. Android ARM64 executes the Rust binary.
2. Rust becomes ready on loopback.
3. Bun becomes ready on loopback.
4. cloudflared establishes an outbound Quick Tunnel to Bun only.
5. The temporary public hostname reaches Bun.
6. A public enqueue without bearer auth returns 401.
7. The rejected request does not create task 1.
8. An authenticated public enqueue creates task 1.
9. Repeating the same request and Idempotency-Key replays task 1.
10. Reusing the key for a changed request returns 409.
11. Public task snapshots preserve registry mapping but do not expose payload.
12. SQLite persistence exists locally.

Expected final line:

```text
TryCloudflare -> Bun bearer -> Rust integration: OK
```

This is a reference-machine proof only. If a stable hostname is needed later, use a regular named Cloudflare Tunnel from the main Cloudflare dashboard (`Networking -> Tunnels`) with a domain on Cloudflare, while keeping the same Bun bearer boundary.
