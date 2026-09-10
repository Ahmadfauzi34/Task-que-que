#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
BROKER_PID=""

cleanup() {
  if [ -n "$BROKER_PID" ]; then
    kill -INT "$BROKER_PID" >/dev/null 2>&1 || true
    wait "$BROKER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

wait_ready() {
  attempt=1
  while [ "$attempt" -le 80 ]; do
    if curl -fsS http://127.0.0.1:7332/readyz >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
    attempt=$((attempt + 1))
  done
  echo "worker broker did not become ready" >&2
  cat "$TMP_DIR/broker.log" >&2 || true
  return 1
}

cd "$ROOT_DIR"
./target/debug/robust-sinkhorn-worker serve \
  --db "$TMP_DIR/queue.db" \
  --dispatch-interval-ms 100 \
  --session-ttl-ms 1200 \
  --task-lease-ms 600 \
  >"$TMP_DIR/broker.log" 2>&1 &
BROKER_PID=$!

wait_ready

initial="$(curl -fsS http://127.0.0.1:7332/v1/providers)"
printf '%s' "$initial" | grep -F '"schema_version":1' >/dev/null
printf '%s' "$initial" | grep -F '"active_task_names":[]' >/dev/null

registration="$(curl -fsS -X POST http://127.0.0.1:7332/v1/register \
  -H 'X-Worker-Id: provider-proof' \
  -H 'X-Worker-Type: remote-agent' \
  -H 'X-Worker-Capacity: 1' \
  -H 'X-Worker-Tasks: agent.invoke')"
printf '%s' "$registration" | grep -F '"session_id"' >/dev/null
printf '%s' "$registration" | grep -F '"session_token"' >/dev/null

live="$(curl -fsS http://127.0.0.1:7332/v1/providers)"
printf '%s' "$live" | grep -F '"active_task_names":["agent.invoke"]' >/dev/null
printf '%s' "$live" | grep -F '"worker_types":["remote-agent"]' >/dev/null

for forbidden in 'provider-proof' 'session_id' 'session_token'; do
  if printf '%s' "$live" | grep -F "$forbidden" >/dev/null; then
    echo "provider snapshot leaked worker/session detail: $forbidden" >&2
    exit 1
  fi
done

sleep 1.5
expired="$(curl -fsS http://127.0.0.1:7332/v1/providers)"
printf '%s' "$expired" | grep -F '"active_task_names":[]' >/dev/null
if printf '%s' "$expired" | grep -F 'agent.invoke' >/dev/null; then
  echo "expired worker session remained executable" >&2
  exit 1
fi

echo "Provider availability snapshot: OK"
echo "Live worker task advertised: OK"
echo "Expired worker task withdrawn: OK"
echo "Provider snapshot secret minimization: OK"
