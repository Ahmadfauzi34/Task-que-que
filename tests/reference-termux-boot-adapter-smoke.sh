#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

HOME_DIR="$TMP/home"
FAKE_ROOT="$TMP/reference-root"
FAKE_DATA="$HOME_DIR/.task-queue"
FAKE_BOOT="$HOME_DIR/.termux/boot"
FAKE_BIN="$TMP/bin"
CALL_LOG="$TMP/lifecycle-calls.log"

mkdir -p "$HOME_DIR" "$FAKE_ROOT/ops" "$FAKE_DATA" "$FAKE_BOOT" "$FAKE_BIN"
cp "$ROOT/ops/termux-boot-entrypoint.sh" "$FAKE_ROOT/ops/termux-boot-entrypoint.sh"

for name in queue broker bun cloudflared; do
  cat > "$FAKE_BIN/$name" <<'EOF_BIN'
#!/usr/bin/env sh
exit 0
EOF_BIN
  chmod 700 "$FAKE_BIN/$name"
done

cat > "$FAKE_ROOT/ops/termux-reference-machine.sh" <<'EOF_LIFECYCLE'
#!/usr/bin/env sh
set -eu

DATA_DIR="${TASK_QUEUE_DATA_DIR:?}"
CALL_LOG="${FAKE_CALL_LOG:?}"
cmd="${1:?}"
tunnel="${TASK_QUEUE_ENABLE_TUNNEL:-unset}"
probe="${TASK_QUEUE_PUBLIC_READY_PROBE:-unset}"

mkdir -p "$DATA_DIR"
printf '%s tunnel=%s probe=%s\n' "$cmd" "$tunnel" "$probe" >> "$CALL_LOG"

case "$cmd" in
  start)
    if [ "$tunnel" = "0" ]; then
      printf 'ready\n' > "$DATA_DIR/local-ready"
      exit 0
    fi

    count_file="$DATA_DIR/fake-tunnel-count"
    count=0
    [ ! -f "$count_file" ] || count="$(cat "$count_file")"
    count=$((count + 1))
    printf '%s\n' "$count" > "$count_file"

    if [ "${FAKE_TUNNEL_ALWAYS_FAIL:-0}" = "1" ]; then
      exit 1
    fi

    if [ "$count" -lt 2 ]; then
      exit 1
    fi

    printf 'https://boot-adapter-proof.trycloudflare.com\n' > "$DATA_DIR/public-url"
    exit 0
    ;;
  status)
    count_file="$DATA_DIR/fake-public-count"
    count=0
    [ ! -f "$count_file" ] || count="$(cat "$count_file")"
    count=$((count + 1))
    printf '%s\n' "$count" > "$count_file"

    if [ "${FAKE_PUBLIC_ALWAYS_FAIL:-0}" = "1" ]; then
      exit 1
    fi

    if [ "$count" -lt 2 ]; then
      exit 1
    fi

    printf 'reference machine: READY\n'
    exit 0
    ;;
  *)
    exit 2
    ;;
esac
EOF_LIFECYCLE
chmod 700 "$FAKE_ROOT/ops/termux-reference-machine.sh"

INSTALL_ENV=(
  "HOME=$HOME_DIR"
  "TASK_QUEUE_ROOT_DIR=$FAKE_ROOT"
  "TASK_QUEUE_DATA_DIR=$FAKE_DATA"
  "TASK_QUEUE_BOOT_DIR=$FAKE_BOOT"
  "TASK_QUEUE_RUST_BIN=$FAKE_BIN/queue"
  "TASK_QUEUE_WORKER_BIN=$FAKE_BIN/broker"
  "TASK_QUEUE_BUN_BIN=$FAKE_BIN/bun"
  "TASK_QUEUE_CLOUDFLARED_BIN=$FAKE_BIN/cloudflared"
  "TASK_QUEUE_BOOT_WAKE_LOCK=0"
  "TASK_QUEUE_BOOT_TUNNEL_ATTEMPTS=2"
  "TASK_QUEUE_BOOT_TUNNEL_DELAY_SECONDS=0"
  "TASK_QUEUE_BOOT_PUBLIC_ATTEMPTS=2"
  "TASK_QUEUE_BOOT_PUBLIC_DELAY_SECONDS=0"
  "GATEWAY_API_TOKEN=must-not-be-baked"
)

env "${INSTALL_ENV[@]}" sh "$ROOT/ops/install-termux-boot.sh" > "$TMP/install.out"

BOOT_SCRIPT="$FAKE_BOOT/50-task-queue-reference-machine"
[ -x "$BOOT_SCRIPT" ]
grep -F '# task-queue-reference-boot-adapter:v1' "$BOOT_SCRIPT" >/dev/null
if grep -F 'must-not-be-baked' "$BOOT_SCRIPT" >/dev/null; then
  echo 'boot adapter smoke error: gateway token leaked into installed adapter' >&2
  exit 1
fi

env HOME="$HOME_DIR" FAKE_CALL_LOG="$CALL_LOG" sh "$BOOT_SCRIPT"

EXPECTED="$TMP/expected-calls.log"
cat > "$EXPECTED" <<'EOF_EXPECTED'
start tunnel=0 probe=0
start tunnel=1 probe=0
start tunnel=1 probe=0
status tunnel=1 probe=1
status tunnel=1 probe=1
status tunnel=1 probe=1
EOF_EXPECTED

diff -u "$EXPECTED" "$CALL_LOG"

grep -F 'local reference machine READY' "$FAKE_DATA/logs/boot.log" >/dev/null
grep -F 'Cloudflare transport attached; waiting for public readiness' "$FAKE_DATA/logs/boot.log" >/dev/null
grep -F 'reference machine PUBLIC READY' "$FAKE_DATA/logs/boot.log" >/dev/null
[ "$(cat "$FAKE_DATA/public-url")" = 'https://boot-adapter-proof.trycloudflare.com' ]

# Re-installing our own marked adapter is allowed and remains deterministic.
BEFORE_SHA="$(sha256sum "$BOOT_SCRIPT" | awk '{print $1}')"
env "${INSTALL_ENV[@]}" sh "$ROOT/ops/install-termux-boot.sh" > "$TMP/reinstall.out"
AFTER_SHA="$(sha256sum "$BOOT_SCRIPT" | awk '{print $1}')"
[ "$BEFORE_SHA" = "$AFTER_SHA" ]

# A failed public transport attach must not turn into a second lifecycle authority.
# The adapter retries only through the proven lifecycle entrypoint and never calls stop.
rm -f "$CALL_LOG" "$FAKE_DATA/fake-tunnel-count" "$FAKE_DATA/fake-public-count" "$FAKE_DATA/public-url"
set +e
env HOME="$HOME_DIR" FAKE_CALL_LOG="$CALL_LOG" FAKE_TUNNEL_ALWAYS_FAIL=1 sh "$BOOT_SCRIPT"
FAIL_CODE=$?
set -e
[ "$FAIL_CODE" -ne 0 ]
grep -F 'start tunnel=0 probe=0' "$CALL_LOG" >/dev/null
grep -F 'start tunnel=1 probe=0' "$CALL_LOG" >/dev/null
if grep -E '^stop ' "$CALL_LOG" >/dev/null; then
  echo 'boot adapter smoke error: adapter attempted to become a stop authority' >&2
  exit 1
fi
grep -F 'local reference machine is ready but Cloudflare transport could not be attached' "$FAKE_DATA/logs/boot.log" >/dev/null

printf '%s\n' 'Termux:Boot adapter proof state'
printf '%-38s %s\n' 'installed adapter provenance' 'OK'
printf '%-38s %s\n' 'gateway token not baked' 'OK'
printf '%-38s %s\n' 'local-first lifecycle transition' 'OK'
printf '%-38s %s\n' 'bounded tunnel retry' 'OK'
printf '%-38s %s\n' 'public readiness convergence' 'OK'
printf '%-38s %s\n' 'idempotent adapter install' 'OK'
printf '%-38s %s\n' 'second lifecycle authority' 'NOT INTRODUCED'
printf '\nReference Termux:Boot adapter: OK\n'
