#!/usr/bin/env bash
#
# Phase 8b Linux/Wayland application-menu MVP gate driver.
#
# Companion to scripts/qa/qa-linux-matrix.sh. Drives the running rdc
# development build through the seven states of the menu state matrix
# (qa/phase-8b/menu-mvp-alignment-checklist.md) over the debug-only `qa-drive`
# channel, then prompts the host operator to press PrtScn and tags the
# capture. The vision-capable reviewer examines the PNGs.
#
# Environment: Fedora 44 toolbox on a Bluefin host (same as the matrix
# driver). Input injection from the container is impossible (uinput and the
# virtual-keyboard protocol are not available through the toolbox bridge; see
# MIGRATION_MAP.md §8), so interactive steps are printed for the host operator
# and the script pauses for PrtScn between them.
#
# Usage:
#   bash scripts/qa/qa-linux-menu-gate.sh
#
# State -> how it is reached:
#   1 no repositories            fresh app data dir + no CLI arg
#   2 clean repo, no integrations  CLI arg = <fixture>/clean
#   3 populated, Changes          CLI arg = <fixture>/populated; driver view=changes
#   4 populated, History          driver view=history (host clicks a commit)
#   5 remote idle + busy          populated has a remote; host clicks Push on
#                                 <fixture>/delayedPush for the busy state
#   6 merge conflict              CLI arg = <fixture>/mergeConflict
#   7 two windows                 host uses File -> Open new window
#
# The driver file path is read from $RDC_QA_DRIVER (default
# /tmp/rdc-qa-driver.json), matching src-tauri/src/qa_driver.rs.

set -euo pipefail

QA_SHOT_DIR="${QA_SHOT_DIR:-/var/home/joseg/Pictures/Screenshots}"
QA_EVIDENCE_DIR="${QA_EVIDENCE_DIR:-/tmp/rdc-qa-evidence-menu}"
DRIVER_FILE="${RDC_QA_DRIVER:-/tmp/rdc-qa-driver.json}"
FIXTURE_ROOT="${RDC_QA_FIXTURE:-/tmp/rdc-phase8b-linux-menu-gate}"

mkdir -p "$QA_EVIDENCE_DIR"
echo "Screenshot dir : $QA_SHOT_DIR"
echo "Evidence dir   : $QA_EVIDENCE_DIR"
echo "Driver file    : $DRIVER_FILE"
echo "Fixture root   : $FIXTURE_ROOT"

write_driver() {
  printf '%s' "$1" > "$DRIVER_FILE"
}

# Capture: wait for a NEW file in the screenshot dir, tag it with the cell name.
# $1 = tag
wait_capture() {
  local tag="$1"
  local before
  before=$(ls "$QA_SHOT_DIR" | wc -l)
  echo
  echo "==> [HOST OPERATOR] press PrtScn now to capture: $tag"
  for _ in $(seq 1 60); do
    local now
    now=$(ls "$QA_SHOT_DIR" | wc -l)
    if [ "$now" -gt "$before" ]; then
      local newest
      newest=$(ls -t "$QA_SHOT_DIR" | head -1)
      cp "$QA_SHOT_DIR/$newest" "$QA_EVIDENCE_DIR/$tag.png"
      echo "    captured $tag.png from $newest"
      return 0
    fi
    sleep 1
  done
  echo "    no new screenshot within 60s for $tag" >&2
  return 1
}

echo
echo "State 1/7 - no repository registered or selected."
echo "  Prereq: the app must be running with a FRESH data dir"
echo "  (e.g. XDG_DATA_HOME=/tmp/rdc-menu-empty) and no CLI repo."
write_driver '{}'
wait_capture '1-no-repository'

echo
echo "State 2/7 - clean repository selected, no integrations."
echo "  Prereq: app running with <fixture>/clean as the selected repo."
write_driver '{"repository":"'"$FIXTURE_ROOT"'/clean"}'
wait_capture '2-clean-no-integrations'

echo
echo "State 2b/7 - clean repository with editor and shell configured."
echo "  [HOST OPERATOR] File -> Options..., set an external editor and a shell."
wait_capture '2b-clean-with-integrations'

echo
echo "State 3/7 - populated in Changes."
write_driver '{"repository":"'"$FIXTURE_ROOT"'/populated","view":"changes","sidebarCollapsed":false}'
wait_capture '3-populated-changes'

echo
echo "State 4/7 - History with a selected commit and changed file."
echo "  [HOST OPERATOR] click a commit in History, then a changed file."
write_driver '{"repository":"'"$FIXTURE_ROOT"'/populated","view":"history"}'
wait_capture '4-populated-history'

echo
write_driver '{"repository":"'"$FIXTURE_ROOT"'/populated","view":"changes"}'
wait_capture '5-remote-idle'

echo
echo "State 5b/7 - remote busy: Push in progress on the delayedPush repo."
echo "  Prereq: app running with <fixture>/delayedPush selected (restart with that CLI arg)."
echo "  [HOST OPERATOR] Repository -> Push, then press PrtScn while the progress bar is up."
write_driver '{"repository":"'"$FIXTURE_ROOT"'/delayedPush"}'
wait_capture '5b-remote-busy'

echo
echo "State 6/7 - merge-conflict state."
echo "  Prereq: app running with <fixture>/mergeConflict as the selected repo."
write_driver '{"repository":"'"$FIXTURE_ROOT"'/mergeConflict"}'
wait_capture '6-merge-conflict'

echo
echo "State 7/7 - two windows, different repositories, alternating focus."
echo "  [HOST OPERATOR] File -> Open new window on the populated repo,"
echo "  then alternate focus between the two windows."
wait_capture '7-two-windows'

echo
echo "Menu gate captures complete in $QA_EVIDENCE_DIR"
