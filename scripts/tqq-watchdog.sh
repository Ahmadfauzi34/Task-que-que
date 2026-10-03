#!/bin/bash
# TQQ Watchdog: supervisor ringan untuk Task-que-que di Termux.
# Memastikan gateway, daemon, dan broker tetap jalan.
# Dijalankan sekali di dalam Termux (bukan via SSH).
#
# Cara pakai:
#   bash ~/tqq/bin/tqq-watchdog.sh start   # mulai watchdog (background)
#   bash ~/tqq/bin/tqq-watchdog.sh stop    # hentikan watchdog
#   bash ~/tqq/bin/tqq-watchdog.sh status  # cek status layanan

WATCHDOG_PID_FILE="$HOME/tqq/.watchdog.pid"
WATCHDOG_LOG="$HOME/tqq/watchdog.log"
CHECK_INTERVAL=15

GATEWAY_PORT=3100
DAEMON_PORT=7331
BROKER_PORT=7332

log() {
  echo "[$(date '+%F %T')] $*" >> "$WATCHDOG_LOG"
}

is_up() {
  curl -s --max-time 5 "http://127.0.0.1:$1/$2" > /dev/null 2>&1
}

start_gateway() {
  log "starting gateway..."
  export GATEWAY_API_TOKEN=$(cat "$HOME/handoff-data/gateway-token")
  export GATEWAY_PORT=$GATEWAY_PORT
  cd "$HOME/tqq/gateway-pr66"
  setsid bun src/server.ts >> "$HOME/tqq/gateway.log" 2>&1 < /dev/null &
  log "gateway pid: $!"
}

start_daemon() {
  log "starting queue daemon..."
  cd "$HOME/tqq"
  setsid ./bin/robust-sinkhorn-queue-v021 serve --db "$HOME/tqq/queue.db" >> "$HOME/tqq/daemon.log" 2>&1 < /dev/null &
  log "daemon pid: $!"
  # fallback ke binary lama jika v021 tidak ada
  if ! is_up $DAEMON_PORT "healthz"; then
    sleep 2
    if ! is_up $DAEMON_PORT "healthz"; then
      log "v021 failed, trying legacy binary..."
      setsid ./bin/robust-sinkhorn-queue serve --db "$HOME/tqq/queue.db" >> "$HOME/tqq/daemon.log" 2>&1 < /dev/null &
    fi
  fi
}

start_broker() {
  log "starting broker..."
  cd "$HOME/tqq"
  setsid ./bin/robust-sinkhorn-worker serve --db "$HOME/tqq/queue.db" >> "$HOME/tqq/broker.log" 2>&1 < /dev/null &
  log "broker pid: $!"
}

check_and_heal() {
  if ! is_up $GATEWAY_PORT "readyz"; then
    log "WARN: gateway down, restarting..."
    pkill -9 -f "gateway-pr66/src/server.ts" 2>/dev/null
    sleep 2
    start_gateway
  fi
  if ! is_up $DAEMON_PORT "healthz"; then
    log "WARN: daemon down, restarting..."
    pkill -9 -f "robust-sinkhorn-queue" 2>/dev/null
    sleep 2
    start_daemon
  fi
  if ! is_up $BROKER_PORT "healthz"; then
    log "WARN: broker down, restarting..."
    pkill -9 -f "robust-sinkhorn-worker serve" 2>/dev/null
    sleep 2
    start_broker
  fi
}

watchdog_loop() {
  log "watchdog started (interval ${CHECK_INTERVAL}s)"
  while true; do
    check_and_heal
    sleep $CHECK_INTERVAL
  done
}

case "${1:-status}" in
  start)
    if [ -f "$WATCHDOG_PID_FILE" ] && kill -0 $(cat "$WATCHDOG_PID_FILE") 2>/dev/null; then
      echo "watchdog sudah jalan (pid $(cat $WATCHDOG_PID_FILE))"
      exit 0
    fi
    # start awal semua layanan
    check_and_heal
    # jalankan loop di background
    setsid bash "$0" loop >> "$WATCHDOG_LOG" 2>&1 < /dev/null &
    echo $! > "$WATCHDOG_PID_FILE"
    echo "watchdog started (pid $!)"
    ;;
  loop)
    watchdog_loop
    ;;
  stop)
    if [ -f "$WATCHDOG_PID_FILE" ]; then
      kill $(cat "$WATCHDOG_PID_FILE") 2>/dev/null
      rm -f "$WATCHDOG_PID_FILE"
      echo "watchdog stopped"
    else
      echo "watchdog tidak jalan"
    fi
    ;;
  status)
    for svc in "gateway:$GATEWAY_PORT:readyz" "daemon:$DAEMON_PORT:healthz" "broker:$BROKER_PORT:healthz"; do
      name=$(echo $svc | cut -d: -f1)
      port=$(echo $svc | cut -d: -f2)
      path=$(echo $svc | cut -d: -f3)
      if is_up $port $path; then
        echo "$name: UP (:$port)"
      else
        echo "$name: DOWN (:$port)"
      fi
    done
    if [ -f "$WATCHDOG_PID_FILE" ] && kill -0 $(cat "$WATCHDOG_PID_FILE") 2>/dev/null; then
      echo "watchdog: RUNNING"
    else
      echo "watchdog: STOPPED"
    fi
    ;;
esac
