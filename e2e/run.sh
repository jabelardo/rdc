#!/usr/bin/env bash
set -euo pipefail

# Phase 0 scaffold: there is no app or E2E spec suite yet (that's Phase 8,
# once the app has an actual UI and the Squirrel->tauri-plugin-updater swap
# from Phase 4 has landed). This script exists to make the harness itself
# — the container, tauri-driver, WebKitWebDriver, Xvfb — a real, checkable
# thing rather than an aspirational Dockerfile. Replace the body below with
# the real WebDriver/Playwright suite in Phase 8; keep the Xvfb/env setup.
#
# Xvfb is started directly here rather than via the `xvfb-run` wrapper:
# xvfb-run's readiness handshake waits on a SIGUSR1 signal from Xvfb to its
# parent, which hangs indefinitely when that parent is PID 1 in a container
# (no init process to mediate signal delivery the way it expects on a
# normal Linux desktop). Polling for the display socket avoids that.

export DISPLAY=:99
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

echo "==> Verifying tauri-driver starts under this container's WebKitWebDriver..."
tauri-driver --port 4444 &
DRIVER_PID=$!
sleep 2

if ! kill -0 "${DRIVER_PID}" 2>/dev/null; then
  echo "tauri-driver failed to start or exited early" >&2
  exit 1
fi

echo "==> tauri-driver is running (pid ${DRIVER_PID}) against Xvfb ${DISPLAY}. Harness OK."
echo "==> No E2E spec suite yet — see MIGRATION_PLAN.md Phase 8."
