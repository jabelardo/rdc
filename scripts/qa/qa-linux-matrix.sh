#!/usr/bin/env bash
#
# Phase 8b Linux/Wayland visual-matrix driver.
#
# Drives the running rdc development build through each visual-matrix cell by
# writing state to the debug-only QA driver file, then supervisions the shared
# host screenshot directory for the PrtScn capture the host produces.
#
# Environment:
#   - Fedora 44 toolbox on a Bluefin host. The rdc app renders on the host's
#     GNOME/Wayland session; screenshots taken by the host (PrtScn) land in the
#     host's ~/Pictures/Screenshots, which is shared into the container at
#     /var/home/joseg/Pictures/Screenshots.
#   - Input injection from inside the container is impossible (uinput is denied
#     at the device cgroup; see MIGRATION_MAP.md §8), so THIS SCRIPT DOES NOT
#     MOVE THE MOUSE OR CLICK. It sets app state over the debug-only `qa-drive`
#     channel and the host captures. The vision-capable LLM (running wherever it
#     can see the PNGs) reviews each capture.
#
# Usage:
#   bash scripts/qa/qa-linux-matrix.sh
#
# The script is interactive: for each cell it writes the driver state, prints a
# prompt telling the host operator to press PrtScn, waits for a new file to
# appear in the screenshot directory, tags it with the cell name, and moves on.
#
# The driver file path is read from $RDC_QA_DRIVER (default /tmp/rdc-qa-driver.json),
# matching the debug-only watcher in src-tauri/src/qa_driver.rs.

set -euo pipefail

QA_SHOT_DIR="${QA_SHOT_DIR:-/var/home/joseg/Pictures/Screenshots}"
QA_EVIDENCE_DIR="${QA_EVIDENCE_DIR:-/tmp/rdc-qa-evidence}"
DRIVER_FILE="${RDC_QA_DRIVER:-/tmp/rdc-qa-driver.json}"
REPO_PATH="${RDC_QA_REPO:-/tmp/rdc-phase8b-fedora-cycle-1/populated}"
# Colon-separated list of themes to capture; extend or narrow per run, e.g.
# RDC_QA_THEMES=dark. Defaults to the two explicit matrix themes (Light and
# Dark); "system" is intentionally excluded — it depends on the host's global
# scheme, and the matrix reviews each theme deterministically instead.
THEMES="${RDC_QA_THEMES:-light:dark}"

# The matrix viewports x views x sidebar states, per qa/phase-8b/visual-matrix.md.
# Each theme repeats these in order: normal -> default -> compact, then the
# sidebar-collapsed and history passes. Each row: name-suffix width height view sidebar.
# name-suffix               w     h     view      sidebar
CELLS=(
  "normal-expanded"         1100  720   changes   expanded
  "default-expanded"        800   600   changes   expanded
  "compact-expanded"        715   720   changes   expanded
  "normal-collapsed"        1100  720   changes   collapsed
  "default-collapsed"       800   600   changes   collapsed
  "compact-collapsed"       715   720   changes   collapsed
  "normal-history"          1100  720   history   expanded
  "default-history"         800   600   history   expanded
  "compact-history"         715   720   history   expanded
)

mkdir -p "$QA_EVIDENCE_DIR"

echo "QA driver file : $DRIVER_FILE"
echo "Screenshot dir : $QA_SHOT_DIR"
echo "Evidence dir   : $QA_EVIDENCE_DIR"
echo "Repository     : $REPO_PATH"
echo "Themes         : ${THEMES//:/, }"

# Waits for a newly-created file to appear in the screenshot dir after writing
# a driver state, then copies it to the evidence dir under the cell name.
capture_cell() {
  local name="$1" w="$2" h="$3" view="$4" sidebar="$5" theme="$6"
  local before newest

  before="$(ls -1 "$QA_SHOT_DIR" 2>/dev/null | sort)"

  cat > "$DRIVER_FILE" <<JSON
{
  "width": $w,
  "height": $h,
  "theme": "$theme",
  "view": "$view",
  "sidebarCollapsed": $([ "$sidebar" = collapsed ] && echo true || echo false),
  "repository": "$REPO_PATH"
}
JSON

  echo
  echo "=== Cell: $name  (${w}x${h}, view=$view, sidebar=$sidebar, theme=$theme) ==="
  echo "State written to $DRIVER_FILE"
  echo ">>> PRESS PrtScn on the HOST now to capture this cell <<<"

  local deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    sleep 1
    newest="$(ls -1 "$QA_SHOT_DIR" 2>/dev/null | sort | tail -1 || true)"
    if [[ -n "$newest" && "$(ls -1 "$QA_SHOT_DIR" | sort)" != "$before" ]]; then
      cp "$QA_SHOT_DIR/$newest" "$QA_EVIDENCE_DIR/$name.png"
      echo "Captured -> $QA_EVIDENCE_DIR/$name.png"
      return 0
    fi
  done
  echo "WARN: no new screenshot within 120s for $name (skipping)" >&2
  return 1
}

main() {
  : > "$DRIVER_FILE"
  if ! pgrep -f "target/debug/rdc" >/dev/null; then
    echo "ERROR: rdc dev build is not running." >&2
    echo "Start it with: WEBKIT_DISABLE_COMPOSITING_MODE=1 pnpm tauri dev" >&2
    exit 1
  fi

  IFS=':' read -r -a theme_list <<< "$THEMES"
  for theme in "${theme_list[@]}"; do
    [[ -n "$theme" ]] || continue
    echo
    echo "########## Theme: $theme ##########"
    for (( i=0; i<${#CELLS[@]}; i+=5 )); do
      local suffix="${CELLS[$i]}" w="${CELLS[$i+1]}" h="${CELLS[$i+2]}" \
        view="${CELLS[$i+3]}" sidebar="${CELLS[$i+4]}"
      capture_cell "${suffix}-${theme}" "$w" "$h" "$view" "$sidebar" "$theme"
    done
  done

  echo
  echo "All cells captured to $QA_EVIDENCE_DIR"
  echo "Next: run the vision LLM over $QA_EVIDENCE_DIR per qa/phase-8b/visual-matrix.md."
}

main "$@"
