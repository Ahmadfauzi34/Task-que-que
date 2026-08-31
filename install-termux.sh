#!/data/data/com.termux/files/usr/bin/sh
set -eu

REPO="Ahmadfauzi34/Task-que-que"
ASSET="robust-sinkhorn-queue-aarch64-linux-android"
CHECKSUM_ASSET="${ASSET}.sha256"
VERSION="${TASK_QUEUE_VERSION:-latest}"
INSTALL_DIR="${TASK_QUEUE_INSTALL_DIR:-$HOME/.local/bin}"
DATA_DIR="${TASK_QUEUE_DATA_DIR:-$HOME/.task-queue}"
DEST="${INSTALL_DIR}/robust-sinkhorn-queue"

fail() {
  printf 'install error: %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required (Termux: pkg install curl)"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required (Termux: pkg install coreutils)"
command -v mktemp >/dev/null 2>&1 || fail "mktemp is required (Termux: pkg install coreutils)"

ARCH="$(uname -m 2>/dev/null || true)"
case "$ARCH" in
  aarch64|arm64) ;;
  *) fail "unsupported architecture '$ARCH'; this release currently supports Android ARM64 only" ;;
esac

[ -x /system/bin/linker64 ] || fail "Android 64-bit linker not found at /system/bin/linker64"

if [ "$VERSION" = "latest" ]; then
  BASE_URL="https://github.com/${REPO}/releases/latest/download"
else
  case "$VERSION" in
    v*) ;;
    *) fail "TASK_QUEUE_VERSION must be 'latest' or a tag like v0.1.0" ;;
  esac
  BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT HUP INT TERM

printf 'Installing robust-sinkhorn-queue (%s) for Android ARM64...\n' "$VERSION"
cd "$TMP_DIR"

curl -fL --retry 3 --retry-delay 1 \
  "${BASE_URL}/${ASSET}" \
  -o "$ASSET"

curl -fL --retry 3 --retry-delay 1 \
  "${BASE_URL}/${CHECKSUM_ASSET}" \
  -o "$CHECKSUM_ASSET"

sha256sum -c "$CHECKSUM_ASSET"

mkdir -p "$INSTALL_DIR" "$DATA_DIR"
chmod 755 "$ASSET"
mv "$ASSET" "$DEST"

printf '\nInstalled: %s\n' "$DEST"
"$DEST" version

printf '\nRunning runtime/database doctor...\n'
"$DEST" doctor --db "$DATA_DIR/queue.db"

case ":${PATH:-}:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    printf '\nPATH note: add this to your shell profile if needed:\n'
    printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    ;;
esac

printf '\nReady. Start the daemon with:\n'
printf '  %s serve --db "%s/queue.db"\n' "$DEST" "$DATA_DIR"
