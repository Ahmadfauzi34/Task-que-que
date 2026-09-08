#!/data/data/com.termux/files/usr/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"
ROOT_DIR="${TASK_QUEUE_ROOT_DIR:-$(CDPATH= cd "$SCRIPT_DIR/.." && pwd)}"
DATA_DIR="${TASK_QUEUE_DATA_DIR:-$HOME/.task-queue}"
LIFECYCLE="$ROOT_DIR/ops/termux-reference-machine.sh"
ENABLE_TUNNEL="${TASK_QUEUE_RESUME_ENABLE_TUNNEL:-1}"
TUNNEL_ATTEMPTS="${TASK_QUEUE_RESUME_TUNNEL_ATTEMPTS:-6}"
TUNNEL_DELAY_SECONDS="${TASK_QUEUE_RESUME_TUNNEL_DELAY_SECONDS:-5}"
PUBLIC_READY_PROBE="${TASK_QUEUE_RESUME_PUBLIC_READY_PROBE:-0}"
PUBLIC_ATTEMPTS="${TASK_QUEUE_RESUME_PUBLIC_ATTEMPTS:-60}"
PUBLIC_DELAY_SECONDS="${TASK_QUEUE_RESUME_PUBLIC_DELAY_SECONDS:-2}"

fail() {
  printf 'reference resume error: %s\n' "$*" >&2
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
  TASK_QUEUE_ROOT_DIR="$ROOT_DIR" \
  TASK_QUEUE_DATA_DIR="$DATA_DIR" \
  TASK_QUEUE_ENABLE_TUNNEL="$tunnel" \
  TASK_QUEUE_PUBLIC_READY_PROBE="$public_probe" \
    sh "$LIFECYCLE" "$command_name"
}

validate_bool TASK_QUEUE_RESUME_ENABLE_TUNNEL "$ENABLE_TUNNEL"
validate_bool TASK_QUEUE_RESUME_PUBLIC_READY_PROBE "$PUBLIC_READY_PROBE"
validate_uint TASK_QUEUE_RESUME_TUNNEL_ATTEMPTS "$TUNNEL_ATTEMPTS" 360
validate_uint TASK_QUEUE_RESUME_TUNNEL_DELAY_SECONDS "$TUNNEL_DELAY_SECONDS" 300
validate_uint TASK_QUEUE_RESUME_PUBLIC_ATTEMPTS "$PUBLIC_ATTEMPTS" 600
validate_uint TASK_QUEUE_RESUME_PUBLIC_DELAY_SECONDS "$PUBLIC_DELAY_SECONDS" 300
[ -f "$LIFECYCLE" ] || fail "lifecycle entrypoint not found: $LIFECYCLE"

printf 'reference resume: local-first recovery\n'
run_lifecycle 0 0 start || fail "local reference machine failed to recover"
printf 'reference resume: local machine READY\n'

if [ "$ENABLE_TUNNEL" = "0" ]; then
  run_lifecycle 0 0 status || fail "local reference machine is not ready"
  printf 'reference resume: READY local-only\n'
  exit 0
fi

[ "$TUNNEL_ATTEMPTS" -gt 0 ] || fail "public transport enabled but tunnel attempts is 0"

attached=0
attempt=1
while [ "$attempt" -le "$TUNNEL_ATTEMPTS" ]; do
  printf 'reference resume: tunnel attach attempt=%s/%s\n' "$attempt" "$TUNNEL_ATTEMPTS"
  if run_lifecycle 1 0 start; then
    attached=1
    break
  fi
  if [ "$attempt" -lt "$TUNNEL_ATTEMPTS" ] && [ "$TUNNEL_DELAY_SECONDS" -gt 0 ]; then
    sleep "$TUNNEL_DELAY_SECONDS"
  fi
  attempt=$((attempt + 1))
done

[ "$attached" = "1" ] || fail "local machine is ready but Cloudflare transport could not attach"

if [ "$PUBLIC_READY_PROBE" = "0" ]; then
  run_lifecycle 1 0 status || fail "reference machine is not ready after tunnel attach"
  public_url=""
  if [ -s "$DATA_DIR/public-url" ]; then
    public_url="$(sed -n '1p' "$DATA_DIR/public-url")"
  fi
  if [ -n "$public_url" ]; then
    printf 'reference resume: READY local + transport %s\n' "$public_url"
  else
    printf 'reference resume: READY local + transport\n'
  fi
  printf 'reference resume: public readiness not awaited; set TASK_QUEUE_RESUME_PUBLIC_READY_PROBE=1 for strict public convergence\n'
  exit 0
fi

[ "$PUBLIC_ATTEMPTS" -gt 0 ] || fail "public readiness enabled but public attempts is 0"

printf 'reference resume: waiting for public readiness\n'
attempt=1
while [ "$attempt" -le "$PUBLIC_ATTEMPTS" ]; do
  if run_lifecycle 1 1 status >/dev/null 2>&1; then
    run_lifecycle 1 1 status
    printf 'reference resume: PUBLIC READY\n'
    exit 0
  fi

  printf 'reference resume: public readiness pending attempt=%s/%s\n' "$attempt" "$PUBLIC_ATTEMPTS"
  if [ "$attempt" -lt "$PUBLIC_ATTEMPTS" ] && [ "$PUBLIC_DELAY_SECONDS" -gt 0 ]; then
    sleep "$PUBLIC_DELAY_SECONDS"
  fi
  attempt=$((attempt + 1))
done

run_lifecycle 1 1 status || true
fail "local machine and tunnel are running but public readiness did not converge"
