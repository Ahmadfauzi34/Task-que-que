#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd "$(dirname "$0")/.." && pwd)"
BIN="${TASK_QUEUE_PROCESS_EXEC_BIN:-$ROOT_DIR/target/debug/robust-sinkhorn-process-exec}"

fail() {
  printf 'fd-bound process exec smoke failed: %s\n' "$*" >&2
  exit 1
}

[ -x "$BIN" ] || fail "process exec helper is not executable: $BIN"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/tqq-process-exec.XXXXXX")"
cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

mkdir -p "$TMP/cwd"
OUT="$TMP/output.txt"
ERR="$TMP/error.txt"

TASK_QUEUE_PROCESS_SHOULD_NOT_LEAK="secret" \
  "$BIN" \
    --binary "$BIN" \
    --cwd "$TMP/cwd" \
    -- \
    --self-proof-child proof-marker \
    >"$OUT" 2>"$ERR" \
  || fail "fd-bound self execution failed"

grep -Fx 'fd_bound_child=OK' "$OUT" >/dev/null \
  || fail "child did not prove fd-bound execution"
grep -Fx 'marker=proof-marker' "$OUT" >/dev/null \
  || fail "fixed child argument was not preserved"
grep -Fx "cwd=$TMP/cwd" "$OUT" >/dev/null \
  || fail "fd-bound cwd was not applied"
grep -Fx 'lang=C' "$OUT" >/dev/null \
  || fail "LANG was not pinned"
grep -Fx 'lc_all=C' "$OUT" >/dev/null \
  || fail "LC_ALL was not pinned"
grep -Fx 'path=/nonexistent' "$OUT" >/dev/null \
  || fail "PATH was not pinned"
grep -Fx 'leaked=ABSENT' "$OUT" >/dev/null \
  || fail "inherited environment leaked into target"

ln -s "$BIN" "$TMP/binary-link"
if "$BIN" --binary "$TMP/binary-link" --cwd "$TMP/cwd" -- --self-proof-child bad \
  >/dev/null 2>&1; then
  fail "symlink executable was accepted"
fi

ln -s "$TMP/cwd" "$TMP/cwd-link"
if "$BIN" --binary "$BIN" --cwd "$TMP/cwd-link" -- --self-proof-child bad \
  >/dev/null 2>&1; then
  fail "symlink cwd was accepted"
fi

cat >"$TMP/script" <<'EOF_SCRIPT'
#!/bin/sh
exit 0
EOF_SCRIPT
chmod 700 "$TMP/script"
if "$BIN" --binary "$TMP/script" --cwd "$TMP/cwd" -- >/dev/null 2>&1; then
  fail "shebang script was accepted as a native executable"
fi

printf '%s\n' \
  'FD-bound process execution substrate proof state' \
  'native ELF execution                 : OK' \
  'executable identity                  : FD-BOUND' \
  'cwd identity                         : FD-BOUND' \
  'inherited environment                : SCRUBBED' \
  'fixed arguments                      : OK' \
  'symlink executable                   : REJECTED' \
  'symlink cwd                          : REJECTED' \
  'shebang script                       : REJECTED' \
  '' \
  'Rust fd-bound process execution substrate: OK'
