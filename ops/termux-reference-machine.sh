#!/data/data/com.termux/files/usr/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"
ROOT_DIR="${TASK_QUEUE_ROOT_DIR:-$(CDPATH= cd "$SCRIPT_DIR/.." && pwd)}"
DATA_DIR="${TASK_QUEUE_DATA_DIR:-$HOME/.task-queue}"
PID_DIR="$DATA_DIR/pids"
LOG_DIR="$DATA_DIR/logs"
RESULT_DIR="$DATA_DIR/results"
DB_PATH="$DATA_DIR/queue.db"
TOKEN_FILE="$DATA_DIR/gateway-token"
PUBLIC_URL_FILE="$DATA_DIR/public-url"

QUEUE_BIN="${TASK_QUEUE_RUST_BIN:-$HOME/.local/bin/robust-sinkhorn-queue}"
BROKER_BIN="${TASK_QUEUE_WORKER_BIN:-$HOME/.local/bin/robust-sinkhorn-worker}"
BUN_BIN="${TASK_QUEUE_BUN_BIN:-$HOME/.local/bin/task-queue-bun}"
CLOUDFLARED_BIN="${TASK_QUEUE_CLOUDFLARED_BIN:-cloudflared}"
ENABLE_TUNNEL="${TASK_QUEUE_ENABLE_TUNNEL:-1}"
ENABLE_REMOTE_AGENT="${TASK_QUEUE_ENABLE_REMOTE_AGENT:-0}"
PUBLIC_READY_PROBE="${TASK_QUEUE_PUBLIC_READY_PROBE:-1}"

QUEUE_READY_URL="http://127.0.0.1:7331/readyz"
GATEWAY_READY_URL="http://127.0.0.1:3000/readyz"
BROKER_READY_URL="http://127.0.0.1:7332/readyz"

STARTED_COMPONENTS=""
COMPONENT_PID=""
COMPONENT_STATE=""
IN_START=0
SCRIPT_ANCESTORS=""

fail() {
  message="$*"
  if [ "$IN_START" = "1" ]; then
    IN_START=0
    rollback_started
  fi
  printf 'reference machine error: %s\n' "$message" >&2
  exit 1
}

validate_bool() {
  case "$2" in
    0|1) ;;
    *) fail "$1 must be 0 or 1" ;;
  esac
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

pid_file() {
  printf '%s/%s.pid\n' "$PID_DIR" "$1"
}

read_pid() {
  file="$(pid_file "$1")"
  [ -f "$file" ] || return 1
  pid="$(sed -n '1p' "$file" 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  COMPONENT_PID="$pid"
  return 0
}

pid_matches() {
  pid="$1"
  marker="$2"
  [ -r "/proc/$pid/cmdline" ] || return 1
  cmdline="$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  case "$cmdline" in
    *"$marker"*) return 0 ;;
    *) return 1 ;;
  esac
}

inspect_component() {
  name="$1"
  marker="$2"
  COMPONENT_PID=""
  COMPONENT_STATE="missing"
  file="$(pid_file "$name")"
  [ -f "$file" ] || return 0
  if ! read_pid "$name"; then
    COMPONENT_STATE="invalid-pid"
    return 0
  fi
  if ! kill -0 "$COMPONENT_PID" 2>/dev/null; then
    COMPONENT_STATE="stale"
    return 0
  fi
  if ! pid_matches "$COMPONENT_PID" "$marker"; then
    COMPONENT_STATE="pid-reused"
    return 0
  fi
  COMPONENT_STATE="running"
}

refresh_script_ancestors() {
  SCRIPT_ANCESTORS=""
  current="$$"
  while [ -n "$current" ] && [ "$current" != "0" ] && [ "$current" != "1" ]; do
    SCRIPT_ANCESTORS="$SCRIPT_ANCESTORS $current"
    [ -r "/proc/$current/status" ] || break
    current="$(sed -n 's/^PPid:[[:space:]]*//p' "/proc/$current/status" | head -n 1)"
  done
}

is_script_ancestor() {
  candidate="$1"
  [ -n "$SCRIPT_ANCESTORS" ] || refresh_script_ancestors
  case " $SCRIPT_ANCESTORS " in
    *" $candidate "*) return 0 ;;
    *) return 1 ;;
  esac
}

find_process_by_marker() {
  marker="$1"
  process_table="$(ps -ef 2>/dev/null || true)"
  while IFS= read -r line; do
    case "$line" in
      *"$marker"*)
        set -f
        set -- $line
        set +f
        [ "$#" -ge 2 ] || continue
        pid="$2"
        case "$pid" in ''|*[!0-9]*) continue ;; esac
        is_script_ancestor "$pid" && continue
        printf '%s\n' "$pid"
        return 0
        ;;
    esac
  done <<EOF_PROCESS_TABLE
$process_table
EOF_PROCESS_TABLE
  return 1
}

probe_any() {
  curl -sS --max-time 1 "$1" >/dev/null 2>&1
}

probe_ready() {
  curl -fsS --max-time 2 "$1" >/dev/null 2>&1
}

wait_for_url() {
  url="$1"
  log="$2"
  count=0
  while [ "$count" -lt 100 ]; do
    if probe_ready "$url"; then
      return 0
    fi
    count=$((count + 1))
    sleep 0.2
  done
  [ ! -s "$log" ] || tail -n 80 "$log" >&2 || true
  return 1
}

wait_for_log() {
  pattern="$1"
  log="$2"
  count=0
  while [ "$count" -lt 100 ]; do
    if grep -F "$pattern" "$log" >/dev/null 2>&1; then
      return 0
    fi
    count=$((count + 1))
    sleep 0.2
  done
  [ ! -s "$log" ] || tail -n 80 "$log" >&2 || true
  return 1
}

cleanup_stale_pid() {
  name="$1"
  marker="$2"
  inspect_component "$name" "$marker"
  case "$COMPONENT_STATE" in
    running) return 0 ;;
    missing) return 0 ;;
    stale|invalid-pid|pid-reused)
      printf '%s: clearing %s pid record\n' "$name" "$COMPONENT_STATE"
      rm -f "$(pid_file "$name")"
      COMPONENT_PID=""
      COMPONENT_STATE="missing"
      ;;
  esac
}

prepare_start() {
  name="$1"
  marker="$2"
  occupancy_url="${3:-}"

  cleanup_stale_pid "$name" "$marker"
  inspect_component "$name" "$marker"
  if [ "$COMPONENT_STATE" = "running" ]; then
    if [ -n "$occupancy_url" ] && ! probe_ready "$occupancy_url"; then
      fail "$name pid $COMPONENT_PID is running but not ready"
    fi
    printf '%s: already running pid=%s\n' "$name" "$COMPONENT_PID"
    return 1
  fi

  if [ -n "$occupancy_url" ] && probe_any "$occupancy_url"; then
    fail "$name endpoint is already occupied by an unmanaged process: $occupancy_url"
  fi

  unmanaged="$(find_process_by_marker "$marker" 2>/dev/null || true)"
  if [ -n "$unmanaged" ]; then
    fail "$name process exists without a valid lifecycle pid record (pid=$unmanaged)"
  fi

  return 0
}

record_pid() {
  name="$1"
  pid="$2"
  tmp="$(pid_file "$name").tmp.$$"
  printf '%s\n' "$pid" > "$tmp"
  mv "$tmp" "$(pid_file "$name")"
}

start_process() {
  name="$1"
  marker="$2"
  cwd="$3"
  log="$4"
  shift 4

  old_pwd="$PWD"
  cd "$cwd"
  nohup "$@" >"$log" 2>&1 </dev/null &
  pid=$!
  cd "$old_pwd"
  record_pid "$name" "$pid"
  STARTED_COMPONENTS="$STARTED_COMPONENTS $name"
  sleep 0.1
  if ! kill -0 "$pid" 2>/dev/null; then
    [ ! -s "$log" ] || tail -n 80 "$log" >&2 || true
    fail "$name exited during startup"
  fi
  if ! pid_matches "$pid" "$marker"; then
    [ ! -s "$log" ] || tail -n 80 "$log" >&2 || true
    fail "$name startup pid does not match expected command marker"
  fi
  printf '%s: started pid=%s\n' "$name" "$pid"
}

ensure_token() {
  mkdir -p "$DATA_DIR"
  if [ ! -s "$TOKEN_FILE" ]; then
    old_umask="$(umask)"
    umask 077
    tmp="$TOKEN_FILE.tmp.$$"
    head -c 32 /dev/urandom | base64 | tr -d '\n' > "$tmp"
    [ -s "$tmp" ] || fail "could not generate gateway token"
    mv "$tmp" "$TOKEN_FILE"
    umask "$old_umask"
    printf 'gateway token: generated persistent secret at %s\n' "$TOKEN_FILE"
  fi
  chmod 600 "$TOKEN_FILE"
}

stop_component() {
  name="$1"
  marker="$2"
  inspect_component "$name" "$marker"
  case "$COMPONENT_STATE" in
    missing)
      printf '%s: stopped\n' "$name"
      return 0
      ;;
    stale|invalid-pid|pid-reused)
      printf '%s: removing %s pid record without signalling a process\n' "$name" "$COMPONENT_STATE"
      rm -f "$(pid_file "$name")"
      return 0
      ;;
  esac

  pid="$COMPONENT_PID"
  kill -INT "$pid" 2>/dev/null || true
  count=0
  while kill -0 "$pid" 2>/dev/null && [ "$count" -lt 20 ]; do
    count=$((count + 1))
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    count=0
    while kill -0 "$pid" 2>/dev/null && [ "$count" -lt 10 ]; do
      count=$((count + 1))
      sleep 0.1
    done
  fi
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
  rm -f "$(pid_file "$name")"
  printf '%s: stopped pid=%s\n' "$name" "$pid"
}

rollback_started() {
  case " $STARTED_COMPONENTS " in *" cloudflared "*) stop_component cloudflared "tunnel --url http://127.0.0.1:3000" ;; esac
  case " $STARTED_COMPONENTS " in *" remote-agent-worker "*) stop_component remote-agent-worker "workers/remote-agent-bun/src/worker.ts" ;; esac
  case " $STARTED_COMPONENTS " in *" vector-worker "*) stop_component vector-worker "workers/vector-bun/src/worker.ts" ;; esac
  case " $STARTED_COMPONENTS " in *" workflow-worker "*) stop_component workflow-worker "workers/workflow-bun/src/worker.ts" ;; esac
  case " $STARTED_COMPONENTS " in *" cpu-worker "*) stop_component cpu-worker "workers/document-bun/src/worker.ts" ;; esac
  case " $STARTED_COMPONENTS " in *" broker "*) stop_component broker "robust-sinkhorn-worker" ;; esac
  case " $STARTED_COMPONENTS " in *" gateway "*) stop_component gateway "src/server.ts" ;; esac
  case " $STARTED_COMPONENTS " in *" queue "*) stop_component queue "robust-sinkhorn-queue" ;; esac
  rm -f "$PUBLIC_URL_FILE"
}

preflight() {
  validate_bool TASK_QUEUE_ENABLE_TUNNEL "$ENABLE_TUNNEL"
  validate_bool TASK_QUEUE_ENABLE_REMOTE_AGENT "$ENABLE_REMOTE_AGENT"
  validate_bool TASK_QUEUE_PUBLIC_READY_PROBE "$PUBLIC_READY_PROBE"
  require_command curl
  require_command nohup
  require_command ps
  require_command grep
  require_command sed
  require_command tr
  require_command base64
  require_command head
  require_executable "$QUEUE_BIN"
  require_executable "$BROKER_BIN"
  require_executable "$BUN_BIN"
  if [ "$ENABLE_TUNNEL" = "1" ]; then
    require_executable "$CLOUDFLARED_BIN"
  fi
  [ -f "$ROOT_DIR/gateway/src/server.ts" ] || fail "gateway source not found under $ROOT_DIR"
  [ -f "$ROOT_DIR/workers/document-bun/src/worker.ts" ] || fail "document worker source not found"
  [ -f "$ROOT_DIR/workers/workflow-bun/src/worker.ts" ] || fail "workflow worker source not found"
  [ -f "$ROOT_DIR/workers/vector-bun/src/worker.ts" ] || fail "vector worker source not found"
  if [ "$ENABLE_REMOTE_AGENT" = "1" ]; then
    [ -f "$ROOT_DIR/workers/remote-agent-bun/src/worker.ts" ] || fail "remote-agent worker source not found"
  fi
  mkdir -p "$PID_DIR" "$LOG_DIR" \
    "$RESULT_DIR/document" "$RESULT_DIR/workflow" "$RESULT_DIR/vector" "$RESULT_DIR/remote-agent"
}

start_queue() {
  if prepare_start queue "robust-sinkhorn-queue" "$QUEUE_READY_URL"; then
    start_process queue "robust-sinkhorn-queue" "$ROOT_DIR" "$LOG_DIR/queue.log" \
      "$QUEUE_BIN" serve --db "$DB_PATH"
  fi
  wait_for_url "$QUEUE_READY_URL" "$LOG_DIR/queue.log" || fail "queue did not become ready"
}

start_gateway() {
  probe_ready "$QUEUE_READY_URL" || fail "queue must be ready before gateway"
  ensure_token
  token="$(cat "$TOKEN_FILE")"
  if prepare_start gateway "src/server.ts" "$GATEWAY_READY_URL"; then
    start_process gateway "src/server.ts" "$ROOT_DIR/gateway" "$LOG_DIR/gateway.log" \
      env GATEWAY_API_TOKEN="$token" "$BUN_BIN" run src/server.ts
  fi
  wait_for_url "$GATEWAY_READY_URL" "$LOG_DIR/gateway.log" || fail "gateway did not become ready"
}

start_broker() {
  probe_ready "$QUEUE_READY_URL" || fail "queue must be ready before broker"
  if prepare_start broker "robust-sinkhorn-worker" "$BROKER_READY_URL"; then
    start_process broker "robust-sinkhorn-worker" "$ROOT_DIR" "$LOG_DIR/broker.log" \
      "$BROKER_BIN" serve --db "$DB_PATH"
  fi
  wait_for_url "$BROKER_READY_URL" "$LOG_DIR/broker.log" || fail "worker broker did not become ready"
}

start_cpu_worker() {
  probe_ready "$BROKER_READY_URL" || fail "broker must be ready before cpu worker"
  if prepare_start cpu-worker "workers/document-bun/src/worker.ts" ""; then
    start_process cpu-worker "workers/document-bun/src/worker.ts" "$ROOT_DIR" "$LOG_DIR/cpu-worker.log" \
      env DOCUMENT_WORKER_ORIGIN="http://127.0.0.1:7332" \
      DOCUMENT_WORKER_OUTPUT_DIR="$RESULT_DIR/document" \
      "$BUN_BIN" run workers/document-bun/src/worker.ts
  fi
  wait_for_log 'id=document-reference-worker' "$LOG_DIR/cpu-worker.log" || fail "cpu worker did not register"
}

start_workflow_worker() {
  probe_ready "$BROKER_READY_URL" || fail "broker must be ready before workflow worker"
  probe_ready "$GATEWAY_READY_URL" || fail "gateway must be ready before workflow worker"
  ensure_token
  token="$(cat "$TOKEN_FILE")"
  if prepare_start workflow-worker "workers/workflow-bun/src/worker.ts" ""; then
    start_process workflow-worker "workers/workflow-bun/src/worker.ts" "$ROOT_DIR" "$LOG_DIR/workflow-worker.log" \
      env WORKFLOW_WORKER_ORIGIN="http://127.0.0.1:7332" \
      WORKFLOW_GATEWAY_ORIGIN="http://127.0.0.1:3000" \
      WORKFLOW_RESULT_ORIGIN="http://127.0.0.1:7331" \
      WORKFLOW_GATEWAY_API_TOKEN="$token" \
      WORKFLOW_WORKER_OUTPUT_DIR="$RESULT_DIR/workflow" \
      "$BUN_BIN" run workers/workflow-bun/src/worker.ts
  fi
  wait_for_log 'id=workflow-reference-worker' "$LOG_DIR/workflow-worker.log" || fail "workflow worker did not register"
}

start_vector_worker() {
  probe_ready "$BROKER_READY_URL" || fail "broker must be ready before vector worker"
  if prepare_start vector-worker "workers/vector-bun/src/worker.ts" ""; then
    start_process vector-worker "workers/vector-bun/src/worker.ts" "$ROOT_DIR" "$LOG_DIR/vector-worker.log" \
      env VECTOR_WORKER_ORIGIN="http://127.0.0.1:7332" \
      VECTOR_WORKER_OUTPUT_DIR="$RESULT_DIR/vector" \
      "$BUN_BIN" run workers/vector-bun/src/worker.ts
  fi
  wait_for_log 'id=vector-reference-worker' "$LOG_DIR/vector-worker.log" || fail "vector worker did not register"
}

start_remote_agent_worker() {
  [ "$ENABLE_REMOTE_AGENT" = "1" ] || return 0
  probe_ready "$BROKER_READY_URL" || fail "broker must be ready before remote-agent worker"
  if prepare_start remote-agent-worker "workers/remote-agent-bun/src/worker.ts" ""; then
    start_process remote-agent-worker "workers/remote-agent-bun/src/worker.ts" "$ROOT_DIR" "$LOG_DIR/remote-agent-worker.log" \
      env REMOTE_AGENT_WORKER_ORIGIN="http://127.0.0.1:7332" \
      REMOTE_AGENT_OUTPUT_DIR="$RESULT_DIR/remote-agent" \
      "$BUN_BIN" run workers/remote-agent-bun/src/worker.ts
  fi
  wait_for_log 'id=remote-agent-reference-worker' "$LOG_DIR/remote-agent-worker.log" || fail "remote-agent worker did not register"
}

extract_public_url() {
  grep -oE 'https://[A-Za-z0-9.-]+\.trycloudflare\.com' "$LOG_DIR/cloudflared.log" 2>/dev/null | tail -n 1
}

start_tunnel() {
  [ "$ENABLE_TUNNEL" = "1" ] || {
    rm -f "$PUBLIC_URL_FILE"
    printf 'cloudflared: disabled\n'
    return 0
  }
  probe_ready "$GATEWAY_READY_URL" || fail "gateway must be ready before cloudflared"
  if prepare_start cloudflared "tunnel --url http://127.0.0.1:3000" ""; then
    rm -f "$PUBLIC_URL_FILE"
    start_process cloudflared "tunnel --url http://127.0.0.1:3000" "$ROOT_DIR" "$LOG_DIR/cloudflared.log" \
      "$CLOUDFLARED_BIN" tunnel --url http://127.0.0.1:3000
  fi

  count=0
  public_url=""
  while [ "$count" -lt 120 ]; do
    public_url="$(extract_public_url || true)"
    [ -n "$public_url" ] && break
    inspect_component cloudflared "tunnel --url http://127.0.0.1:3000"
    [ "$COMPONENT_STATE" = "running" ] || break
    count=$((count + 1))
    sleep 0.25
  done
  [ -n "$public_url" ] || {
    [ ! -s "$LOG_DIR/cloudflared.log" ] || tail -n 80 "$LOG_DIR/cloudflared.log" >&2 || true
    fail "cloudflared did not publish a trycloudflare URL"
  }
  tmp="$PUBLIC_URL_FILE.tmp.$$"
  printf '%s\n' "$public_url" > "$tmp"
  mv "$tmp" "$PUBLIC_URL_FILE"

  if [ "$PUBLIC_READY_PROBE" = "1" ]; then
    wait_for_url "$public_url/readyz" "$LOG_DIR/cloudflared.log" || fail "public gateway did not become ready through Cloudflare"
  fi
  printf 'public URL: %s\n' "$public_url"
}

start_all() {
  STARTED_COMPONENTS=""
  IN_START=1
  preflight
  trap 'rollback_started; exit 130' HUP INT TERM
  start_queue
  start_gateway
  start_broker
  start_cpu_worker
  start_workflow_worker
  start_vector_worker
  start_remote_agent_worker
  start_tunnel
  trap - HUP INT TERM
  IN_START=0
  printf 'reference machine: READY\n'
}

stop_all() {
  mkdir -p "$PID_DIR"
  stop_component cloudflared "tunnel --url http://127.0.0.1:3000"
  stop_component remote-agent-worker "workers/remote-agent-bun/src/worker.ts"
  stop_component vector-worker "workers/vector-bun/src/worker.ts"
  stop_component workflow-worker "workers/workflow-bun/src/worker.ts"
  stop_component cpu-worker "workers/document-bun/src/worker.ts"
  stop_component broker "robust-sinkhorn-worker"
  stop_component gateway "src/server.ts"
  stop_component queue "robust-sinkhorn-queue"
  rm -f "$PUBLIC_URL_FILE"
  printf 'reference machine: STOPPED\n'
}

print_component_status() {
  name="$1"
  marker="$2"
  readiness="${3:-}"
  registration="${4:-}"
  log="${5:-}"

  inspect_component "$name" "$marker"
  case "$COMPONENT_STATE" in
    running)
      extra=""
      if [ -n "$readiness" ]; then
        if probe_ready "$readiness"; then extra=" ready=yes"; else extra=" ready=no"; STATUS_FAILURES=$((STATUS_FAILURES + 1)); fi
      elif [ -n "$registration" ]; then
        if [ -n "$log" ] && grep -F "$registration" "$log" >/dev/null 2>&1; then extra=" registered=yes"; else extra=" registered=no"; STATUS_FAILURES=$((STATUS_FAILURES + 1)); fi
      fi
      printf '%-20s RUNNING pid=%s%s\n' "$name" "$COMPONENT_PID" "$extra"
      ;;
    missing)
      unmanaged="$(find_process_by_marker "$marker" 2>/dev/null || true)"
      if [ -n "$unmanaged" ]; then
        printf '%-20s UNMANAGED pid=%s\n' "$name" "$unmanaged"
      elif [ -n "$readiness" ] && probe_any "$readiness"; then
        printf '%-20s UNMANAGED endpoint=%s\n' "$name" "$readiness"
      else
        printf '%-20s STOPPED\n' "$name"
      fi
      STATUS_FAILURES=$((STATUS_FAILURES + 1))
      ;;
    *)
      printf '%-20s %s pid=%s\n' "$name" "$COMPONENT_STATE" "${COMPONENT_PID:-unknown}"
      STATUS_FAILURES=$((STATUS_FAILURES + 1))
      ;;
  esac
}

status_all() {
  mkdir -p "$PID_DIR" "$LOG_DIR"
  STATUS_FAILURES=0
  print_component_status queue "robust-sinkhorn-queue" "$QUEUE_READY_URL" "" "$LOG_DIR/queue.log"
  print_component_status gateway "src/server.ts" "$GATEWAY_READY_URL" "" "$LOG_DIR/gateway.log"
  print_component_status broker "robust-sinkhorn-worker" "$BROKER_READY_URL" "" "$LOG_DIR/broker.log"
  print_component_status cpu-worker "workers/document-bun/src/worker.ts" "" 'id=document-reference-worker' "$LOG_DIR/cpu-worker.log"
  print_component_status workflow-worker "workers/workflow-bun/src/worker.ts" "" 'id=workflow-reference-worker' "$LOG_DIR/workflow-worker.log"
  print_component_status vector-worker "workers/vector-bun/src/worker.ts" "" 'id=vector-reference-worker' "$LOG_DIR/vector-worker.log"
  if [ "$ENABLE_REMOTE_AGENT" = "1" ]; then
    print_component_status remote-agent-worker "workers/remote-agent-bun/src/worker.ts" "" 'id=remote-agent-reference-worker' "$LOG_DIR/remote-agent-worker.log"
  else
    printf '%-20s DISABLED\n' remote-agent-worker
  fi

  if [ "$ENABLE_TUNNEL" = "1" ]; then
    print_component_status cloudflared "tunnel --url http://127.0.0.1:3000" "" "" "$LOG_DIR/cloudflared.log"
    if [ -s "$PUBLIC_URL_FILE" ]; then
      public_url="$(sed -n '1p' "$PUBLIC_URL_FILE")"
      if [ "$PUBLIC_READY_PROBE" = "1" ]; then
        if probe_ready "$public_url/readyz"; then
          printf '%-20s READY %s\n' public-ingress "$public_url"
        else
          printf '%-20s UNREACHABLE %s\n' public-ingress "$public_url"
          STATUS_FAILURES=$((STATUS_FAILURES + 1))
        fi
      else
        printf '%-20s URL %s\n' public-ingress "$public_url"
      fi
    else
      printf '%-20s MISSING-URL\n' public-ingress
      STATUS_FAILURES=$((STATUS_FAILURES + 1))
    fi
  else
    printf '%-20s DISABLED\n' cloudflared
    printf '%-20s DISABLED\n' public-ingress
  fi

  if [ "$STATUS_FAILURES" -eq 0 ]; then
    printf 'reference machine: READY\n'
    return 0
  fi
  printf 'reference machine: NOT READY (%s failed checks)\n' "$STATUS_FAILURES"
  return 1
}

usage() {
  cat <<'USAGE'
Usage: sh ops/termux-reference-machine.sh <start|stop|restart|status>

Reference lifecycle for the bounded Termux machine:
  start    start missing owned components in dependency order and verify readiness
  stop     stop only processes owned by lifecycle pid records, in reverse dependency order
  restart  stop then start while preserving queue.db, token, logs, and result artifacts
  status   verify real processes/readiness instead of trusting pid files alone

Key overrides:
  TASK_QUEUE_DATA_DIR
  TASK_QUEUE_RUST_BIN
  TASK_QUEUE_WORKER_BIN
  TASK_QUEUE_BUN_BIN
  TASK_QUEUE_CLOUDFLARED_BIN
  TASK_QUEUE_ENABLE_TUNNEL=0|1
  TASK_QUEUE_PUBLIC_READY_PROBE=0|1
  TASK_QUEUE_ENABLE_REMOTE_AGENT=0|1

The gateway token is persisted at <data-dir>/gateway-token and is never printed.
Quick Tunnel hostnames are persisted at <data-dir>/public-url and may change after restart.
USAGE
}

case "${1:-}" in
  start) start_all ;;
  stop) stop_all ;;
  restart) stop_all; start_all ;;
  status) status_all ;;
  help|-h|--help|'') usage ;;
  *) usage >&2; exit 2 ;;
esac
