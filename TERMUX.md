# Termux deployment without compiling Rust

This project can be deployed to a 64-bit Android/Termux device without installing Rust or Cargo on the device.

## Deployment model

Rust compilation happens in GitHub Actions. Termux only receives the resulting Android ARM64 executable.

```text
GitHub repository
      |
      v
GitHub Actions (Ubuntu + Android NDK)
      |
      v
aarch64-linux-android release binary
      |
      +--> workflow artifact for CI/manual runs
      |
      +--> GitHub Release asset for v* tags
      |
      v
Android / Termux
      |
      v
chmod +x + run
```

## Supported first target

The initial deployment target is:

```text
aarch64-linux-android
```

On the Termux device, verify the architecture:

```sh
uname -m
```

Expected output for this binary:

```text
aarch64
```

## Install from a tagged GitHub Release

Replace `<version>` with a published tag such as `v0.1.0`.

```sh
pkg install -y curl coreutils
mkdir -p "$HOME/.local/bin"
cd "$HOME/.local/bin"

curl -fL \
  "https://github.com/Ahmadfauzi34/Task-que-que/releases/download/<version>/robust-sinkhorn-queue-aarch64-linux-android" \
  -o robust-sinkhorn-queue

curl -fL \
  "https://github.com/Ahmadfauzi34/Task-que-que/releases/download/<version>/robust-sinkhorn-queue-aarch64-linux-android.sha256" \
  -o robust-sinkhorn-queue.sha256
```

The checksum file contains the release filename, so verify it before renaming or from a temporary directory using the original name. A simple flow is:

```sh
mkdir -p "$HOME/tmp/robust-queue-install"
cd "$HOME/tmp/robust-queue-install"

curl -fLO \
  "https://github.com/Ahmadfauzi34/Task-que-que/releases/download/<version>/robust-sinkhorn-queue-aarch64-linux-android"

curl -fLO \
  "https://github.com/Ahmadfauzi34/Task-que-que/releases/download/<version>/robust-sinkhorn-queue-aarch64-linux-android.sha256"

sha256sum -c robust-sinkhorn-queue-aarch64-linux-android.sha256
chmod +x robust-sinkhorn-queue-aarch64-linux-android
mv robust-sinkhorn-queue-aarch64-linux-android "$HOME/.local/bin/robust-sinkhorn-queue"
```

Add the user binary directory to PATH if needed:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Then run:

```sh
robust-sinkhorn-queue
```

## Install from a GitHub Actions artifact

The `Android Termux Binary` workflow uploads an artifact named:

```text
robust-sinkhorn-queue-termux-arm64
```

It contains:

```text
robust-sinkhorn-queue-aarch64-linux-android
robust-sinkhorn-queue-aarch64-linux-android.sha256
```

Artifacts are intended for CI validation and development builds. Tagged GitHub Releases are the preferred distribution path for stable versions.

## What is intentionally not required on Termux

The runtime device does **not** need:

```text
rustc
cargo
Android NDK
C compiler
project source tree
Cargo registry/cache
```

The only project runtime files are the executable and data files it creates, such as `queue.db`.

## Release flow

Normal CI/manual run:

```text
push / pull request / workflow_dispatch
                |
                v
      build Android ARM64
                |
                v
       Actions artifact
```

Stable release:

```text
git tag vX.Y.Z
      |
      v
push tag
      |
      v
Android ARM64 build
      |
      v
GitHub Release assets
```

## Validation boundary

GitHub Actions validates that the produced file is an AArch64 ELF and rejects an obvious glibc-linked output. The definitive runtime compatibility check is still execution on an Android/Termux ARM64 device.

Do not treat a successful cross-build alone as proof that every Android device is supported. The first real-device run should be kept as a release gate before calling the binary generally supported.
