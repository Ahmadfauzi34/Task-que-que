#!/data/data/com.termux/files/usr/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"
ROOT_DIR="${TASK_QUEUE_ROOT_DIR:-$(CDPATH= cd "$SCRIPT_DIR/.." && pwd)}"
DATA_DIR="${TASK_QUEUE_DATA_DIR:-$HOME/.task-queue}"
BOOT_DIR="${TASK_QUEUE_BOOT_DIR:-$HOME/.termux/boot}"
BOOT_NAME="${TASK_QUEUE_BOOT_SCRIPT_NAME:-50-task-queue-reference-machine}"
DEST="$BOOT_DIR/$BOOT_NAME"
ENTRYPOINT="$ROOT_DIR/ops/termux-boot-entrypoint.sh"
LIFECYCLE="$ROOT_DIR/ops/termux-reference-machine.sh"

QUEUE_BIN="${TASK_QUEUE_RUST_BIN:-$HOME/.local/bin/robust-sinkhorn-queue}"
BROKER_BIN="${TASK_QUEUE_WORKER_BIN:-$HOME/.local/bin/robust-sinkhorn-worker}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-$HOME/.local/bin/task-queue-bun}"
CLOUDFLARED_BIN="${TASK_QUEUE_CLOUDFLARED_BIN:-cloudflared}"

ENABLE_TUNNEL="${TASK_QUEUE_BOOT_ENABLE_TUNNEL:-1}"
WAKE_LOCK="${TASK_QUEUE_BOOT_WAKE_LOCK:-0}"
TUNNEL_ATTEMPTS="${TASK_QUEUE_BOOT_TUNNEL_ATTEMPTS:-6}"
TUNNEL_DELAY_SECONDS="${TASK_QUEUE_BOOT_TUNNEL_DELAY_SECONDS:-5}"
PUBLIC_ATTEMPTS="${TASK_QUEUE_BOOT_PUBLIC_ATTEMPTS:-60}"
PUBLIC_DELAY_SECONDS="${TASK_QUEUE_BOOT_PUBLIC_DELAY_SECONDS:-2}"
MARKER='# task-queue-reference-boot-adapter:v1'

fail() {
  printf 'Termux:Boot installer error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

require_executable() {
  case "$1" in
    */*) [ -x "$1" ] || fail "executable not found: $1" ;;
    *) command -v "$1" >/dev/null 2>&1 || fail "executable not found in PATH: $1" ;;
  esac
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

shell_quote() {
  escaped="$(printf '%s' "$1" | sed "s/'/'\"'\"'/g")"
  printf "'%s'" "$escaped"
}

require_command sed
require_command grep
require_command mkdir
require_command chmod
require_command mv

case "$BOOT_NAME" in
  ''|*[!A-Za-z0-9._-]*) fail "TASK_QUEUE_BOOT_SCRIPT_NAME must contain only A-Z, a-z, 0-9, dot, underscore, or dash" ;;
esac

validate_bool TASK_QUEUE_BOOT_ENABLE_TUNNEL "$ENABLE_TUNNEL"
validate_bool TASK_QUEUE_BOOT_WAKE_LOCK "$WAKE_LOCK"
validate_uint TASK_QUEUE_BOOT_TUNNEL_ATTEMPTS "$TUNNEL_ATTEMPTS" 360
validate_uint TASK_QUEUE_BOOT_TUNNEL_DELAY_SECONDS "$TUNNEL_DELAY_SECONDS" 300
validate_uint TASK_QUEUE_BOOT_PUBLIC_ATTEMPTS "$PUBLIC_ATTEMPTS" 600
validate_uint TASK_QUEUE_BOOT_PUBLIC_DELAY_SECONDS "$PUBLIC_DELAY_SECONDS" 300

[ -f "$ENTRYPOINT" ] || fail "boot entrypoint not found: $ENTRYPOINT"
[ -f "$LIFECYCLE" ] || fail "lifecycle entrypoint not found: $LIFECYCLE"
require_executable "$QUEUE_BIN"
require_executable "$BROKER_BIN"
require_executable "$BUN_BIN"
if [ "$ENABLE_TUNNEL" = "1" ]; then
  require_executable "$CLOUDFLARED_BIN"
fi

mkdir -p "$BOOT_DIR" "$DATA_DIR/logs"

if [ -f "$DEST" ] && ! grep -F "$MARKER" "$DEST" >/dev/null 2>&1; then
  fail "refusing to replace non-Task-que-que boot script: $DEST"
fi

tmp="$DEST.tmp.$$"
trap 'rm -f "$tmp"' EXIT HUP INT TERM

{
  printf '%s\n' '#!/data/data/com.termux/files/usr/bin/sh'
  printf '%s\n' 'set -eu'
  printf '%s\n' "$MARKER"
  printf 'export TASK_QUEUE_ROOT_DIR=%s\n' "$(shell_quote "$ROOT_DIR")"
  printf 'export TASK_QUEUE_DATA_DIR=%s\n' "$(shell_quote "$DATA_DIR")"
  printf 'export TASK_QUEUE_RUST_BIN=%s\n' "$(shell_quote "$QUEUE_BIN")"
  printf 'export TASK_QUEUE_WORKER_BIN=%s\n' "$(shell_quote "$BROKER_BIN")"
  printf 'export TASK_QUEUE_BUN_BIN=%s\n' "$(shell_quote "$BUN_BIN")"
  printf 'export TASK_QUEUE_CLOUDFLARED_BIN=%s\n' "$(shell_quote "$CLOUDFLARED_BIN")"
  printf 'export TASK_QUEUE_BOOT_ENABLE_TUNNEL=%s\n' "$(shell_quote "$ENABLE_TUNNEL")"
  printf 'export TASK_QUEUE_BOOT_WAKE_LOCK=%s\n' "$(shell_quote "$WAKE_LOCK")"
  printf 'export TASK_QUEUE_BOOT_TUNNEL_ATTEMPTS=%s\n' "$(shell_quote "$TUNNEL_ATTEMPTS")"
  printf 'export TASK_QUEUE_BOOT_TUNNEL_DELAY_SECONDS=%s\n' "$(shell_quote "$TUNNEL_DELAY_SECONDS")"
  printf 'export TASK_QUEUE_BOOT_PUBLIC_ATTEMPTS=%s\n' "$(shell_quote "$PUBLIC_ATTEMPTS")"
  printf 'export TASK_QUEUE_BOOT_PUBLIC_DELAY_SECONDS=%s\n' "$(shell_quote "$PUBLIC_DELAY_SECONDS")"
  printf 'exec sh %s\n' "$(shell_quote "$ENTRYPOINT")"
} > "$tmp"

chmod 700 "$tmp"
mv "$tmp" "$DEST"
trap - EXIT HUP INT TERM

printf 'Installed Termux:Boot reference adapter: %s\n' "$DEST"
printf 'Reference root: %s\n' "$ROOT_DIR"
printf 'Persistent data: %s\n' "$DATA_DIR"
printf 'Public transport at boot: %s\n' "$ENABLE_TUNNEL"
printf 'Wake lock request at boot: %s\n' "$WAKE_LOCK"
printf 'Boot log: %s\n' "$DATA_DIR/logs/boot.log"
printf '\nTermux:Boot itself is an Android add-on and is not installed by this script.\n'
printf 'Install it from the same trusted Termux app source, open Termux:Boot once, then use a real Android reboot as the physical proof.\n'
