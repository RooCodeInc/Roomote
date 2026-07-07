#!/usr/bin/env bash
# Install a file-watching tool for development rebuild triggers.
#
# - macOS: installs watchman via Homebrew
# - Linux x86_64: installs watchman from Facebook's prebuilt GitHub release,
#   falls back to inotify-tools if watchman has glibc incompatibility
# - Linux aarch64: installs inotify-tools (inotifywait) as a fallback since
#   Facebook does not publish aarch64 watchman binaries
#
#
# Usage: ./scripts/install-watchman.sh
set -euo pipefail

WATCHMAN_VERSION="v2026.02.23.00"

install_inotify_tools() {
  if ! command -v apt-get &>/dev/null; then
    echo "Cannot install inotify-tools automatically: apt-get is unavailable" >&2
    exit 1
  fi

  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y inotify-tools
}

# ── Already installed? ───────────────────────────────────────────────────────
if command -v watchman &>/dev/null && watchman version &>/dev/null; then
  echo "watchman already installed: $(watchman --version 2>&1 | head -1)"
  exit 0
fi

if command -v inotifywait &>/dev/null; then
  echo "inotifywait already installed (file-watcher fallback)"
  exit 0
fi

OS="$(uname -s)"
ARCH="$(uname -m)"

# ── macOS ────────────────────────────────────────────────────────────────────
if [ "$OS" = "Darwin" ]; then
  echo "Installing watchman via Homebrew..."
  brew install watchman
  echo "watchman installed: $(watchman --version 2>&1 | head -1)"
  exit 0
fi

if [ "$OS" != "Linux" ]; then
  echo "Unsupported OS: $OS" >&2
  exit 1
fi

# ── Linux x86_64: prebuilt watchman binary ───────────────────────────────────
if [ "$ARCH" = "x86_64" ]; then
  WATCHMAN_URL="https://github.com/facebook/watchman/releases/download/${WATCHMAN_VERSION}/watchman-${WATCHMAN_VERSION}-linux.zip"

  TMPDIR="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR"' EXIT

  echo "Downloading watchman ${WATCHMAN_VERSION} for x86_64..."
  if curl -fsSL "$WATCHMAN_URL" -o "$TMPDIR/watchman.zip"; then
    echo "Extracting..."
    unzip -q "$TMPDIR/watchman.zip" -d "$TMPDIR"

    WATCHMAN_DIR="$(ls -d "$TMPDIR"/watchman-${WATCHMAN_VERSION}-linux*)"

    echo "Installing to /usr/local..."
    sudo mkdir -p /usr/local/bin /usr/local/lib /usr/local/var/run/watchman
    sudo cp "$WATCHMAN_DIR"/bin/* /usr/local/bin/
    sudo cp -r "$WATCHMAN_DIR"/lib/* /usr/local/lib/
    sudo chmod 755 /usr/local/bin/watchman
    sudo chmod 2777 /usr/local/var/run/watchman

    # Verify the binary actually works (glibc compatibility check)
    if watchman version &>/dev/null; then
      echo "watchman installed: $(watchman --version 2>&1 | head -1)"
      exit 0
    else
      echo "WARNING: watchman binary installed but not functional (likely glibc incompatibility)"
      echo "Falling back to inotify-tools..."
    fi
  else
    echo "WARNING: Failed to download watchman. Falling back to inotify-tools..."
  fi

  # Fallback: install inotify-tools for x86_64 when watchman fails
  echo "Installing inotify-tools as fallback file watcher..."
  install_inotify_tools

  echo "inotify-tools installed (fallback file watcher for x86_64)"
  exit 0
fi

if [ "$ARCH" = "aarch64" ]; then
  if command -v inotifywait &>/dev/null; then
    echo "inotifywait already installed (watchman fallback for aarch64)"
    exit 0
  fi

  echo "No prebuilt watchman for aarch64 Linux. Installing inotify-tools as fallback..."
  install_inotify_tools

  echo "inotify-tools installed (inotifywait fallback for aarch64)"
  exit 0
fi

echo "Unsupported architecture: $ARCH" >&2
exit 1
