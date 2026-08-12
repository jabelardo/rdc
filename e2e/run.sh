#!/usr/bin/env bash
set -euo pipefail

# E2E is deliberately Linux-container-only. Xvfb validates the native
# WebDriver/IPC plumbing; it is not evidence about Wayland rendering.
export DISPLAY=:99
export XDG_CONFIG_HOME=/tmp/rdc-e2e-config
export XDG_DATA_HOME=/tmp/rdc-e2e-data
# Keep the native debug link within the memory budget of the CI container. Callers can
# override this for larger runners when parallel compilation is useful.
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"
# The E2E binary is exercised through WebDriver, not a debugger; stripping Rust debuginfo keeps
# the Tauri/WebKit link below the constrained container memory limit.
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C debuginfo=0"
mkdir -p "${XDG_CONFIG_HOME}" "${XDG_DATA_HOME}"
Xvfb "${DISPLAY}" -screen 0 1280x1024x24 -nolisten tcp &
XVFB_PID=$!

DRIVER_PID=""
cleanup() {
  [ -n "${DRIVER_PID}" ] && kill "${DRIVER_PID}" 2>/dev/null || true
  kill "${XVFB_PID}" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

echo "==> Waiting for Xvfb on ${DISPLAY}..."
for _ in $(seq 1 20); do
  [ -e "/tmp/.X11-unix/X99" ] && break
  sleep 0.5
done
if ! kill -0 "${XVFB_PID}" 2>/dev/null; then
  echo "Xvfb failed to start" >&2
  exit 1
fi

echo "==> Building the debug application exercised by WebDriver..."
cargo build --manifest-path src-tauri/Cargo.toml -p git-ops --bins
pnpm tauri build --debug --no-bundle

echo "==> Starting tauri-driver..."
tauri-driver --port 4444 &
DRIVER_PID=$!
for _ in $(seq 1 20); do
  curl --silent --fail http://127.0.0.1:4444/status >/dev/null 2>&1 && break
  sleep 0.5
done
if ! kill -0 "${DRIVER_PID}" 2>/dev/null; then
  echo "tauri-driver failed to start or exited early" >&2
  exit 1
fi

echo "==> Running the real Tauri WebDriver specs..."
# --test-concurrency=1 is load-bearing, not tidiness. `node --test` runs files in parallel by
# default; these specs each start their own application through the single `tauri-driver` on
# port 4444, and restart.test.mjs terminates the app with a process-wide `pkill -x rdc`.
# Run them in parallel and they destroy each other's sessions.
node --test --test-concurrency=1 --test-timeout=30000 ${E2E_TEST_PATTERN:-e2e/*.test.mjs}
