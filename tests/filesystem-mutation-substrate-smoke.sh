#!/usr/bin/env sh
set -eu

BIN="${TASK_QUEUE_FS_MUTATOR_BIN:-target/debug/robust-sinkhorn-fs-mutator}"
TMP_DIR="$(mktemp -d)"
ROOT="$TMP_DIR/root"
OUTSIDE="$TMP_DIR/outside"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

fail() {
  printf 'filesystem mutation substrate smoke failed: %s\n' "$*" >&2
  exit 1
}

[ -x "$BIN" ] || fail "mutator binary not executable: $BIN"
mkdir -p "$ROOT/nested" "$OUTSIDE"
printf 'outside-original\n' > "$OUTSIDE/secret.txt"
ln -s "$OUTSIDE" "$ROOT/escape-parent"
ln -s "$OUTSIDE/secret.txt" "$ROOT/nested/escape-leaf"
ln -s "$ROOT" "$TMP_DIR/root-link"

"$BIN" probe --root "$ROOT" >/dev/null
if "$BIN" probe --root / >/dev/null 2>&1; then
  fail "host filesystem root was accepted"
fi
if "$BIN" probe --root "$TMP_DIR/root-link" >/dev/null 2>&1; then
  fail "symlinked delegated root was accepted"
fi

printf 'first\n' | "$BIN" write --root "$ROOT" --path nested/file.txt >/dev/null
[ "$(cat "$ROOT/nested/file.txt")" = "first" ] || fail "initial atomic write failed"

printf 'second\n' | "$BIN" write --root "$ROOT" --path nested/file.txt >/dev/null
[ "$(cat "$ROOT/nested/file.txt")" = "second" ] || fail "atomic replacement failed"

printf 'inside-replacement\n' | "$BIN" write --root "$ROOT" --path nested/escape-leaf >/dev/null
[ "$(cat "$ROOT/nested/escape-leaf")" = "inside-replacement" ] || fail "leaf symlink was not replaced safely"
[ "$(cat "$OUTSIDE/secret.txt")" = "outside-original" ] || fail "leaf symlink target was modified"

if printf 'pwned\n' | "$BIN" write --root "$ROOT" --path escape-parent/pwned.txt >/dev/null 2>&1; then
  fail "symlinked parent write was accepted"
fi
[ ! -e "$OUTSIDE/pwned.txt" ] || fail "symlinked parent escaped root"

if printf 'pwned\n' | "$BIN" write --root "$ROOT" --path ../outside/pwned.txt >/dev/null 2>&1; then
  fail "parent traversal write was accepted"
fi
[ ! -e "$OUTSIDE/pwned.txt" ] || fail "parent traversal escaped root"

"$BIN" mkdir --root "$ROOT" --path nested/new-dir >/dev/null
[ -d "$ROOT/nested/new-dir" ] || fail "mkdir failed inside delegated root"

if "$BIN" mkdir --root "$ROOT" --path escape-parent/new-dir >/dev/null 2>&1; then
  fail "mkdir through symlinked parent was accepted"
fi
[ ! -e "$OUTSIDE/new-dir" ] || fail "mkdir escaped delegated root"

printf 'Filesystem mutation substrate proof\n'
printf 'root opened component-by-component : OK\n'
printf 'root symlink                       : REJECTED\n'
printf 'host root /                        : REJECTED\n'
printf 'atomic write/replace               : OK\n'
printf 'leaf symlink target                : NOT FOLLOWED\n'
printf 'symlinked parent                   : REJECTED\n'
printf 'parent traversal                   : REJECTED\n'
printf 'mkdir inside root                  : OK\n'
printf 'outside mutation                   : NOT OBSERVED\n'
printf '\nRust fd-relative filesystem mutation substrate: OK\n'
