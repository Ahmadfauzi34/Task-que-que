#!/data/data/com.termux/files/usr/bin/sh
set -eu

ROOT_DIR="${TASK_QUEUE_ROOT_DIR:-$HOME/Task-que-que}"
DATA_DIR="${TASK_QUEUE_DATA_DIR:-$HOME/.task-queue}"
LIFECYCLE="$ROOT_DIR/ops/termux-reference-machine.sh"
BOOT_LOG="${TASK_QUEUE_BOOT_LOG:-$DATA_DIR/logs/boot.log}"
ENABLE_TUNNEL="${TASK_QUEUE_BOOT_ENABLE_TUNNEL:-1}"
WAKE_LOCK="${TASK_QUEUE_BOOT_WAKE_LOCK:-0}"
TUNNEL_ATTEMPTS="${TASK_QUEUE_BOOT_TUNNEL_ATTEMPTS:-6}"
TUNNEL_DELAY_SECONDS="${TASK_QUEUE_BOOT_TUNNEL_DELAY_SECONDS:-5}"
PUBLIC_ATTEMPTS="${TASK_QUEUE_BOOT_PUBLIC_ATTEMPTS:-60}"
PUBLIC_DELAY_SECONDS="${TASK_QUEUE_BOOT_PUBLIC_DELAY_SECONDS:-2}"

fail() {
  printf '[%s] boot adapter error: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
  exit 1
}

validate_bool() {
  case "$2" in
    0|1) ;;
    *) fail "$1 must be 0 or 1" ;;
  esac
}

validate_uint() {
  name="$1"
  value="$2"
  max="$3"
  case "$value" in
    ''|*[!0-9]*) fail "$name must be an integer between 0 and $max" ;;
  esac
  [ "$value" -le "$max" ] 2>/dev/null || fail "$name must be an integer between 0 and $max"
}

run_lifecycle() {
  tunnel="$1"
  public_probe="$2"
  command_name="$3"
  TASK_QUEUE_ENABLE_TUNNEL="$tunnel" \
  TASK_QUEUE_PUBLIC_READY_PROBE="$public_probe" \
    sh "$LIFECYCLE" "$command_name"
}

mkdir -p "$DATA_DIR/logs"
touch "$BOOT_LOG"
chmod 600 "$BOOT_LOG" 2>/dev/null || true
exec >>"$BOOT_LOG" 2>&1

printf '\n[%s] Termux:Boot adapter invoked pid=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$$"

validate_bool TASK_QUEUE_BOOT_ENABLE_TUNNEL "$ENABLE_TUNNEL"
validate_bool TASK_QUEUE_BOOT_WAKE_LOCK "$WAKE_LOCK"
validate_uint TASK_QUEUE_BOOT_TUNNEL_ATTEMPTS "$TUNNEL_ATTEMPTS" 360
validate_uint TASK_QUEUE_BOOT_TUNNEL_DELAY_SECONDS "$TUNNEL_DELAY_SECONDS" 300
validate_uint TASK_QUEUE_BOOT_PUBLIC_ATTEMPTS "$PUBLIC_ATTEMPTS" 600
validate_uint TASK_QUEUE_BOOT_PUBLIC_DELAY_SECONDS "$PUBLIC_DELAY_SECONDS" 300

[ -f "$LIFECYCLE" ] || fail "lifecycle entrypoint not found: $LIFECYCLE"

if [ "$WAKE_LOCK" = "1" ]; then
  if command -v termux-wake-lock >/dev/null 2>&1; then
    if termux-wake-lock; then
      printf '[%s] wake lock requested\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    else
      printf '[%s] warning: termux-wake-lock failed; continuing without claiming a wake lock\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    fi
  else
    printf '[%s] warning: termux-wake-lock is unavailable; continuing without claiming a wake lock\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
  fi
fi

printf '[%s] local-first lifecycle start\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
if ! run_lifecycle 0 0 start; then
  fail "local reference machine failed to start"
fi
printf '[%s] local reference machine READY\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"

if [ "$ENABLE_TUNNEL" = "0" ]; then
  printf '[%s] boot adapter READY local-only; public transport disabled\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
  exit 0
fi

if [ "$TUNNEL_ATTEMPTS" -eq 0 ]; then
  fail "public transport enabled but TASK_QUEUE_BOOT_TUNNEL_ATTEMPTS is 0"
fi

attached=0
attempt=1
while [ "$attempt" -le "$TUNNEL_ATTEMPTS" ]; do
  printf '[%s] tunnel attach attempt=%s/%s\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$attempt" "$TUNNEL_ATTEMPTS"

  if run_lifecycle 1 0 start; then
    attached=1
    break
  fi

  if [ "$attempt" -lt "$TUNNEL_ATTEMPTS" ] && [ "$TUNNEL_DELAY_SECONDS" -gt 0 ]; then
    sleep "$TUNNEL_DELAY_SECONDS"
  fi
  attempt=$((attempt + 1))
done

if [ "$attached" != "1" ]; then
  fail "local reference machine is ready but Cloudflare transport could not be attached after $TUNNEL_ATTEMPTS attempts"
fi

printf '[%s] Cloudflare transport attached; waiting for public readiness\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"

if [ "$PUBLIC_ATTEMPTS" -eq 0 ]; then
  fail "public transport attached but TASK_QUEUE_BOOT_PUBLIC_ATTEMPTS is 0"
fi

attempt=1
while [ "$attempt" -le "$PUBLIC_ATTEMPTS" ]; do
  if run_lifecycle 1 1 status >/dev/null 2>&1; then
    run_lifecycle 1 1 status || true
    printf '[%s] reference machine PUBLIC READY\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    exit 0
  fi

  printf '[%s] public readiness pending attempt=%s/%s\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$attempt" "$PUBLIC_ATTEMPTS"

  if [ "$attempt" -lt "$PUBLIC_ATTEMPTS" ] && [ "$PUBLIC_DELAY_SECONDS" -gt 0 ]; then
    sleep "$PUBLIC_DELAY_SECONDS"
  fi
  attempt=$((attempt + 1))
done

run_lifecycle 1 1 status || true
fail "local reference machine and tunnel are running but public readiness did not converge after $PUBLIC_ATTEMPTS checks"
