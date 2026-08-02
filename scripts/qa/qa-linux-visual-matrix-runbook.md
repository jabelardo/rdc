# Phase 8b Linux/Wayland visual-matrix — vision-LLM runbook

You are reviewing the rdc app (a GitHub-Desktop-derived Tauri/React app being
ported from Electron) against the Linux visual matrix. You can see images. This
runbook tells you what the captures are, what to verify, and where to record
findings. It pairs with the driver script `scripts/qa/qa-linux-matrix.sh`.

## How the images were produced

- The rdc **development** build runs on a Fedora 44 toolbox inside a Bluefin
  host; it renders on the host's GNOME/Wayland session.
- `qa-linux-matrix.sh` drives app state (window size, theme, view, sidebar,
  repository) over a **debug-only** `qa-drive` channel, then the host operator
  pressed PrtScn. The resulting PNG was tagged with its cell name and placed in
  the evidence directory.
- You do **not** need to run anything; you review PNGs. See the
  `qa/phase-8b/visual-matrix.md` source table for the full matrix definition.

## Your inputs

1. **Captures** — PNGs in `$QA_EVIDENCE_DIR` (default `/tmp/rdc-qa-evidence`),
   named like `normal-expanded-light.png`, `compact-history-light.png`,
   `normal-collapsed-dark.png`, etc. The driver runs the full viewport/view/
   sidebar set once per theme (Light then Dark). "System" is intentionally not
   captured — it resolves to Light or Dark per the host scheme, and the matrix
   reviews each theme deterministically instead.
2. **Checklist** — `qa/phase-8b/visual-matrix.md` (the expected presentation
   states per cell).
3. **Fixture** — each capture uses the `populated` repository, which exercises
   working-tree files, a long file name for truncation review, a text diff,
   commit metadata and sidebar long names.

## Cell naming -> what to expect

| Suffix      | Meaning                                   |
|-------------|-------------------------------------------|
| `normal`    | window ≥ 1100×720 (full-width hierarchy)   |
| `default`   | window 800×600                           |
| `compact`   | window 715×720 (narrowest supported width)|
| `light`     | Light theme                              |
| `dark`      | Dark theme                               |
| `history`   | History view loaded (commit list + diff)  |
| `collapsed` | Repositories/Branches sidebar is collapsed|
| `expanded`  | sidebar expanded (the default/untagged)   |

If the file name lacks a view/sidebar tag, assume Changes + sidebar expanded.

## What to verify in every cell

For each image, inspect and report on **hierarchy, density, alignment,
truncation, focus indication, semantic diff colors, empty/loading/error states
and toolbar grouping**, per `visual-matrix.md`. Concretely:

1. **Repository/branch context**: can you tell which repo/branch is active?
   Does the sidebar list repositories and branches correctly?
2. **Toolbar + frame**: are toolbar buttons grouped, labeled and aligned? Is
   there 2rem of menu-bar chrome at the top (Linux renders an in-window
   File/View/Repository/Help bar)?
3. **Changes view**: folder/file disclosure, working-tree file list, a selected
   text diff with correct added/removed colors, and the commit form
   (message/summary + commit button) visible and not overlapping.
4. **History view** (only in `-history` cells): commit list, per-commit metadata,
   changed-files list and a selected diff.
5. **Sidebar disclosure** (`collapsed` cells should hide it; expanded cells show
   section disclosures).
6. **Long-name handling**: the fixture includes a deliberately very long file
   name — confirm it truncates rather than overflowing or wrapping badly.
7. **Empty/Loading/Error**: if any capture happens to show a state other than
   the settled populated view, call it out explicitly.

## Recording findings

Use the evidence template at `qa/phase-8b/evidence-template.md` as a model.
Record:

- **Cell** (exact tag, e.g. `normal-light`).
- **Verdict**: PASS / PASS-with-notes / FAIL / N/A.
- **Issue descriptions** with the specific visual defect and the screenshot tag
  it appears in. Be precise (e.g. "commit button is right-aligned but the input
  overflows its 1px border on the right at compact width").
- **Severity**: MVP-blocking vs non-blocking. Non-blocking cosmetic nits should
  still be listed so they are not silently lost, but marked clearly.

Prefer the manifest's named reproducible states over trying to catch transient
UI by eye — the captures here should already be settled frames.

## After you finish a cell

Write findings to a new file `$QA_EVIDENCE_DIR/findings.md` (append per cell),
or pass them back to the orchestrating agent. Do not edit
`qa/phase-8b/visual-matrix.md` or any source file while reviewing.

## Not your job

- Do not run or pause the app, press keys, or alter host state.
- The native window title on Linux is a known deferred issue (tao 0.36 / next
  tauri stable) and is **out of scope** for these matrix captures; judge the
  in-webview content only. See `MIGRATION_MAP.md` §8.
