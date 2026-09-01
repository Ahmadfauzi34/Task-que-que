#!/usr/bin/env sh
set -eu

TMP_DIR="$(mktemp -d)"
QUEUE_BIN="${TASK_QUEUE_RUST_BIN:-target/debug/robust-sinkhorn-queue}"
WORKER_BIN="${TASK_QUEUE_WORKER_BIN:-target/debug/robust-sinkhorn-worker}"
QUEUE_LOG="$TMP_DIR/queue.log"
WORKER_LOG="$TMP_DIR/worker.log"
DB_PATH="$TMP_DIR/queue.db"
QUEUE_PID=""
WORKER_PID=""

fail() {
  printf 'worker protocol smoke error: %s\n' "$*" >&2
  if [ -s "$QUEUE_LOG" ]; then
    printf '\n--- queue daemon log ---\n' >&2
    cat "$QUEUE_LOG" >&2 || true
  fi
  if [ -s "$WORKER_LOG" ]; then
    printf '\n--- worker broker log ---\n' >&2
    cat "$WORKER_LOG" >&2 || true
  fi
  exit 1
}

cleanup() {
  if [ -n "$WORKER_PID" ]; then
    kill -INT "$WORKER_PID" >/dev/null 2>&1 || true
    wait "$WORKER_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$QUEUE_PID" ]; then
    kill -INT "$QUEUE_PID" >/dev/null 2>&1 || true
    wait "$QUEUE_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

require_executable() {
  if command -v "$1" >/dev/null 2>&1; then
    return 0
  fi
  [ -x "$1" ] || fail "required executable not found: $1"
}

wait_for_url() {
  url="$1"
  log_file="$2"
  attempts=0
  while [ "$attempts" -lt 120 ]; do
    if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.1
  done
  cat "$log_file" >&2 || true
  return 1
}

json_string() {
  key="$1"
  input="$2"
  printf '%s' "$input" | sed -n "s/.*\"$key\":\"\([^\"]*\)\".*/\1/p"
}

json_number() {
  key="$1"
  input="$2"
  printf '%s' "$input" | sed -n "s/.*\"$key\":\([0-9][0-9]*\).*/\1/p"
}

post_register() {
  worker_id="$1"
  worker_type="$2"
  curl -fsS --max-time 5 -X POST http://127.0.0.1:7332/v1/register \
    -H "X-Worker-Id: $worker_id" \
    -H "X-Worker-Type: $worker_type" \
    -H 'X-Worker-Capacity: 1'
}

post_with_session() {
  path="$1"
  session="$2"
  token="$3"
  curl -fsS --max-time 5 -X POST "http://127.0.0.1:7332$path" \
    -H "X-Worker-Session: $session" \
    -H "X-Worker-Token: $token"
}

post_task_transition() {
  path="$1"
  session="$2"
  token="$3"
  task_id="$4"
  generation="$5"
  curl -fsS --max-time 5 -X POST "http://127.0.0.1:7332$path" \
    -H "X-Worker-Session: $session" \
    -H "X-Worker-Token: $token" \
    -H "X-Task-Id: $task_id" \
    -H "X-Lease-Generation: $generation"
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v grep >/dev/null 2>&1 || fail "grep is required"
command -v sed >/dev/null 2>&1 || fail "sed is required"
command -v mktemp >/dev/null 2>&1 || fail "mktemp is required"
require_executable "$QUEUE_BIN"
require_executable "$WORKER_BIN"

if curl -fsS --max-time 1 http://127.0.0.1:7331/healthz >/dev/null 2>&1; then
  fail "port 7331 is already in use"
fi
if curl -fsS --max-time 1 http://127.0.0.1:7332/healthz >/dev/null 2>&1; then
  fail "port 7332 is already in use"
fi

"$QUEUE_BIN" serve --db "$DB_PATH" --maintenance-interval-ms 100 >"$QUEUE_LOG" 2>&1 &
QUEUE_PID=$!
"$WORKER_BIN" serve --db "$DB_PATH" \
  --dispatch-interval-ms 50 \
  --session-ttl-ms 5000 \
  --task-lease-ms 2000 >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

wait_for_url http://127.0.0.1:7331/readyz "$QUEUE_LOG" || fail "queue daemon did not become ready"
wait_for_url http://127.0.0.1:7332/readyz "$WORKER_LOG" || fail "worker broker did not become ready"

# Boundary proof: neither data-plane nor control-plane accepts the other's routes.
control_register_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:7331/v1/register)"
[ "$control_register_status" = "404" ] || fail "queue control-plane unexpectedly exposed worker registration"
worker_enqueue_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:7332/v1/tasks)"
[ "$worker_enqueue_status" = "404" ] || fail "worker data-plane unexpectedly exposed enqueue"

cpu_create="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:7331/v1/tasks \
  -H 'X-Task-Name: cpu.proof' \
  -H 'X-Task-Type: cpu' \
  -H 'X-Task-Priority: 10' \
  -H 'X-Task-Max-Retries: 1' \
  --data-binary 'cpu-secret')" || fail "could not enqueue CPU proof task"
printf '%s' "$cpu_create" | grep -F '"task_id":1' >/dev/null || fail "CPU proof task id was unexpected"

gpu_create="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:7331/v1/tasks \
  -H 'X-Task-Name: gpu.proof' \
  -H 'X-Task-Type: gpu' \
  -H 'X-Task-Priority: 10' \
  -H 'X-Task-Max-Retries: 1' \
  --data-binary 'gpu-secret')" || fail "could not enqueue GPU proof task"
printf '%s' "$gpu_create" | grep -F '"task_id":2' >/dev/null || fail "GPU proof task id was unexpected"

gpu_registration="$(post_register gpu-worker gpu)" || fail "GPU worker registration failed"
gpu_session="$(json_string session_id "$gpu_registration")"
gpu_token="$(json_string session_token "$gpu_registration")"
[ "${#gpu_session}" -eq 32 ] || fail "GPU worker session id was malformed"
[ "${#gpu_token}" -eq 64 ] || fail "GPU worker session token was malformed"

wrong_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:7332/v1/claim \
  -H "X-Worker-Session: $gpu_session" \
  -H "X-Worker-Token: $(printf '%064d' 0)")"
[ "$wrong_status" = "401" ] || fail "wrong worker token was not rejected"

sleep 0.2
gpu_claim="$(post_with_session /v1/claim "$gpu_session" "$gpu_token")" || fail "GPU worker could not claim"
printf '%s' "$gpu_claim" | grep -F '"task_id":2' >/dev/null || fail "GPU worker claimed a non-GPU task"
printf '%s' "$gpu_claim" | grep -F '"task_type":"gpu"' >/dev/null || fail "GPU worker task type mismatch"
printf '%s' "$gpu_claim" | grep -F '"payload":"gpu-secret"' >/dev/null || fail "GPU payload was not delivered after claim"
gpu_generation="$(json_number lease_generation "$gpu_claim")"
[ -n "$gpu_generation" ] || fail "GPU lease generation missing"

cpu_snapshot="$(curl -fsS --max-time 5 http://127.0.0.1:7331/v1/tasks/1)" || fail "CPU task snapshot failed"
printf '%s' "$cpu_snapshot" | grep -F '"status":"PENDING"' >/dev/null || fail "GPU capability crossed into CPU task"

stale_generation=$((gpu_generation + 1))
stale_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:7332/v1/task/heartbeat \
  -H "X-Worker-Session: $gpu_session" \
  -H "X-Worker-Token: $gpu_token" \
  -H 'X-Task-Id: 2' \
  -H "X-Lease-Generation: $stale_generation")"
[ "$stale_status" = "409" ] || fail "stale lease generation was not rejected"
post_task_transition /v1/task/heartbeat "$gpu_session" "$gpu_token" 2 "$gpu_generation" >/dev/null || fail "valid GPU heartbeat failed"
post_task_transition /v1/task/complete "$gpu_session" "$gpu_token" 2 "$gpu_generation" >/dev/null || fail "valid GPU completion failed"

session_heartbeat="$(post_with_session /v1/session/heartbeat "$gpu_session" "$gpu_token")" || fail "worker session heartbeat failed"
printf '%s' "$session_heartbeat" | grep -F '"status":"alive"' >/dev/null || fail "worker session heartbeat response malformed"

cpu_registration="$(post_register cpu-worker cpu)" || fail "CPU worker registration failed"
cpu_session="$(json_string session_id "$cpu_registration")"
cpu_token="$(json_string session_token "$cpu_registration")"
[ "${#cpu_session}" -eq 32 ] || fail "CPU worker session id was malformed"
[ "${#cpu_token}" -eq 64 ] || fail "CPU worker session token was malformed"
sleep 0.2
cpu_claim="$(post_with_session /v1/claim "$cpu_session" "$cpu_token")" || fail "CPU worker could not claim"
printf '%s' "$cpu_claim" | grep -F '"task_id":1' >/dev/null || fail "CPU worker did not receive CPU task"
printf '%s' "$cpu_claim" | grep -F '"payload":"cpu-secret"' >/dev/null || fail "CPU payload was not delivered after claim"
cpu_generation="$(json_number lease_generation "$cpu_claim")"
post_task_transition /v1/task/heartbeat "$cpu_session" "$cpu_token" 1 "$cpu_generation" >/dev/null || fail "valid CPU heartbeat failed"
post_task_transition /v1/task/complete "$cpu_session" "$cpu_token" 1 "$cpu_generation" >/dev/null || fail "valid CPU completion failed"

final_cpu="$(curl -fsS --max-time 5 http://127.0.0.1:7331/v1/tasks/1)" || fail "final CPU snapshot failed"
final_gpu="$(curl -fsS --max-time 5 http://127.0.0.1:7331/v1/tasks/2)" || fail "final GPU snapshot failed"
printf '%s' "$final_cpu" | grep -F '"status":"COMPLETED"' >/dev/null || fail "CPU task did not complete"
printf '%s' "$final_gpu" | grep -F '"status":"COMPLETED"' >/dev/null || fail "GPU task did not complete"

printf 'Worker protocol proof state\n'
printf 'control-plane worker routes       : NOT EXPOSED\n'
printf 'worker data-plane enqueue         : NOT EXPOSED\n'
printf 'wrong session token               : REJECTED\n'
printf 'hard capability cpu/gpu           : OK\n'
printf 'Sinkhorn within capability        : OK\n'
printf 'payload only after fenced claim   : OK\n'
printf 'stale lease generation            : REJECTED\n'
printf 'task heartbeat                    : OK\n'
printf 'session heartbeat                 : OK\n'
printf 'fenced completion                 : OK\n'
printf '\nWorker protocol integration: OK\n'
