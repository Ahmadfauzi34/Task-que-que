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

stop_process() {
  pid="$1"
  [ -n "$pid" ] || return 0

  kill -INT "$pid" >/dev/null 2>&1 || true
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      wait "$pid" >/dev/null 2>&1 || true
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.1
  done

  kill -TERM "$pid" >/dev/null 2>&1 || true
  attempts=0
  while [ "$attempts" -lt 20 ]; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      wait "$pid" >/dev/null 2>&1 || true
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.1
  done

  kill -KILL "$pid" >/dev/null 2>&1 || true
  wait "$pid" >/dev/null 2>&1 || true
}

cleanup() {
  stop_process "$WORKER_PID"
  stop_process "$QUEUE_PID"
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
  worker_tasks="$3"
  curl -fsS --max-time 5 -X POST http://127.0.0.1:7332/v1/register \
    -H "X-Worker-Id: $worker_id" \
    -H "X-Worker-Type: $worker_type" \
    -H "X-Worker-Tasks: $worker_tasks" \
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

post_task_complete_with_result() {
  session="$1"
  token="$2"
  task_id="$3"
  generation="$4"
  body="$5"
  curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
    -X POST http://127.0.0.1:7332/v1/task/complete \
    -H "X-Worker-Session: $session" \
    -H "X-Worker-Token: $token" \
    -H "X-Task-Id: $task_id" \
    -H "X-Lease-Generation: $generation" \
    -H 'Content-Type: application/json' \
    --data-binary "$body"
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

control_register_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:7331/v1/register)"
[ "$control_register_status" = "404" ] || fail "queue control-plane unexpectedly exposed worker registration"
worker_enqueue_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:7332/v1/tasks)"
[ "$worker_enqueue_status" = "404" ] || fail "worker data-plane unexpectedly exposed enqueue"

missing_tasks_registration_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:7332/v1/register \
  -H 'X-Worker-Id: missing-tasks-worker' \
  -H 'X-Worker-Type: cpu' \
  -H 'X-Worker-Capacity: 1')"
[ "$missing_tasks_registration_status" = "400" ] || fail "worker registration without exact task names was not rejected"

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

unsupported_create="$(curl -fsS --max-time 5 -X POST http://127.0.0.1:7331/v1/tasks \
  -H 'X-Task-Name: cpu.unadvertised' \
  -H 'X-Task-Type: cpu' \
  -H 'X-Task-Priority: 9' \
  -H 'X-Task-Max-Retries: 1' \
  --data-binary 'must-not-be-delivered')" || fail "could not enqueue same-type unsupported task"
printf '%s' "$unsupported_create" | grep -F '"task_id":3' >/dev/null || fail "same-type unsupported task id was unexpected"

gpu_registration="$(post_register gpu-worker gpu gpu.proof)" || fail "GPU worker registration failed"
printf '%s' "$gpu_registration" | grep -F '"task_names":["gpu.proof"]' >/dev/null || fail "GPU exact task advertisement was not echoed"
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
printf '%s' "$gpu_claim" | grep -F '"task_name":"gpu.proof"' >/dev/null || fail "GPU exact task name mismatch"
printf '%s' "$gpu_claim" | grep -F '"task_type":"gpu"' >/dev/null || fail "GPU worker task type mismatch"
printf '%s' "$gpu_claim" | grep -F '"payload":"gpu-secret"' >/dev/null || fail "GPU payload was not delivered after claim"
gpu_generation="$(json_number lease_generation "$gpu_claim")"
[ -n "$gpu_generation" ] || fail "GPU lease generation missing"

cpu_snapshot="$(curl -fsS --max-time 5 http://127.0.0.1:7331/v1/tasks/1)" || fail "CPU task snapshot failed"
printf '%s' "$cpu_snapshot" | grep -F '"status":"PENDING"' >/dev/null || fail "GPU capability crossed into CPU task"
unsupported_snapshot="$(curl -fsS --max-time 5 http://127.0.0.1:7331/v1/tasks/3)" || fail "unsupported CPU task snapshot failed"
printf '%s' "$unsupported_snapshot" | grep -F '"status":"PENDING"' >/dev/null || fail "unsupported CPU task was assigned before a compatible worker existed"

stale_generation=$((gpu_generation + 1))
stale_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:7332/v1/task/heartbeat \
  -H "X-Worker-Session: $gpu_session" \
  -H "X-Worker-Token: $gpu_token" \
  -H 'X-Task-Id: 2' \
  -H "X-Lease-Generation: $stale_generation")"
[ "$stale_status" = "409" ] || fail "stale lease generation was not rejected"

stale_result_status="$(post_task_complete_with_result \
  "$gpu_session" "$gpu_token" 2 "$stale_generation" '{"proof":"stale"}')"
[ "$stale_result_status" = "409" ] || fail "stale result completion was not rejected"
missing_result_status="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:7331/v1/tasks/2/result)"
[ "$missing_result_status" = "404" ] || fail "stale result projection was persisted"

post_task_transition /v1/task/heartbeat "$gpu_session" "$gpu_token" 2 "$gpu_generation" >/dev/null || fail "valid GPU heartbeat failed"
valid_result_status="$(post_task_complete_with_result \
  "$gpu_session" "$gpu_token" 2 "$gpu_generation" '{"proof":"applied","task_id":2}')"
[ "$valid_result_status" = "200" ] || fail "valid GPU result completion failed"
gpu_result="$(curl -fsS --max-time 5 http://127.0.0.1:7331/v1/tasks/2/result)" || fail "GPU result projection query failed"
printf '%s' "$gpu_result" | grep -F '"task_id":2' >/dev/null || fail "GPU result task id mismatch"
printf '%s' "$gpu_result" | grep -F '\"proof\":\"applied\"' >/dev/null || fail "GPU result projection missing"
if printf '%s' "$gpu_result" | grep -F 'lease_generation' >/dev/null; then
  fail "result query leaked fence generation"
fi

session_heartbeat="$(post_with_session /v1/session/heartbeat "$gpu_session" "$gpu_token")" || fail "worker session heartbeat failed"
printf '%s' "$session_heartbeat" | grep -F '"status":"alive"' >/dev/null || fail "worker session heartbeat response malformed"

cpu_registration="$(post_register cpu-worker cpu cpu.proof)" || fail "CPU worker registration failed"
printf '%s' "$cpu_registration" | grep -F '"task_names":["cpu.proof"]' >/dev/null || fail "CPU exact task advertisement was not echoed"
cpu_session="$(json_string session_id "$cpu_registration")"
cpu_token="$(json_string session_token "$cpu_registration")"
[ "${#cpu_session}" -eq 32 ] || fail "CPU worker session id was malformed"
[ "${#cpu_token}" -eq 64 ] || fail "CPU worker session token was malformed"
sleep 0.2
cpu_claim="$(post_with_session /v1/claim "$cpu_session" "$cpu_token")" || fail "CPU worker could not claim"
printf '%s' "$cpu_claim" | grep -F '"task_id":1' >/dev/null || fail "CPU worker did not receive CPU task"
printf '%s' "$cpu_claim" | grep -F '"task_name":"cpu.proof"' >/dev/null || fail "CPU exact task name mismatch"
printf '%s' "$cpu_claim" | grep -F '"payload":"cpu-secret"' >/dev/null || fail "CPU payload was not delivered after claim"
cpu_generation="$(json_number lease_generation "$cpu_claim")"
post_task_transition /v1/task/heartbeat "$cpu_session" "$cpu_token" 1 "$cpu_generation" >/dev/null || fail "valid CPU heartbeat failed"
post_task_transition /v1/task/complete "$cpu_session" "$cpu_token" 1 "$cpu_generation" >/dev/null || fail "legacy empty-body CPU completion failed"
cpu_result_status="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:7331/v1/tasks/1/result)"
[ "$cpu_result_status" = "404" ] || fail "empty-body completion unexpectedly created a result"

sleep 0.2
unsupported_claim_status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:7332/v1/claim \
  -H "X-Worker-Session: $cpu_session" \
  -H "X-Worker-Token: $cpu_token")"
[ "$unsupported_claim_status" = "204" ] || fail "CPU worker received an unadvertised same-type task"
unsupported_snapshot="$(curl -fsS --max-time 5 http://127.0.0.1:7331/v1/tasks/3)" || fail "final unsupported CPU snapshot failed"
printf '%s' "$unsupported_snapshot" | grep -F '"status":"PENDING"' >/dev/null || fail "unadvertised same-type task did not remain pending"

final_cpu="$(curl -fsS --max-time 5 http://127.0.0.1:7331/v1/tasks/1)" || fail "final CPU snapshot failed"
final_gpu="$(curl -fsS --max-time 5 http://127.0.0.1:7331/v1/tasks/2)" || fail "final GPU snapshot failed"
printf '%s' "$final_cpu" | grep -F '"status":"COMPLETED"' >/dev/null || fail "CPU task did not complete"
printf '%s' "$final_gpu" | grep -F '"status":"COMPLETED"' >/dev/null || fail "GPU task did not complete"

printf 'Worker protocol proof state\n'
printf 'control-plane worker routes       : NOT EXPOSED\n'
printf 'worker data-plane enqueue         : NOT EXPOSED\n'
printf 'exact task-name advertisement     : REQUIRED\n'
printf 'same-type unsupported task        : NOT ASSIGNED\n'
printf 'wrong session token               : REJECTED\n'
printf 'hard capability cpu/gpu           : OK\n'
printf 'Sinkhorn within exact capability  : OK\n'
printf 'payload only after fenced claim   : OK\n'
printf 'stale lease generation            : REJECTED\n'
printf 'stale result projection           : REJECTED\n'
printf 'fenced result projection          : OK\n'
printf 'empty completion compatibility    : OK\n'
printf 'task heartbeat                    : OK\n'
printf 'session heartbeat                 : OK\n'
printf 'fenced completion                 : OK\n'
printf '\nWorker protocol integration: OK\n'
