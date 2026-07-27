# `lib/app-state/` — decomposing the app-state god module

`desktop-plus`'s `app/src/lib/app-state.ts` is **1,319 lines with 49 imports**: every piece of
application state in one file, from window widths to Copilot conflict resolutions. That made it a
hub — importing a single type from it dragged in the whole tree, including
`ui/lib/application-theme` and `lib/git/config`. Three deferred tests were blocked on exactly that.

Rather than port the module wholesale, it is being **decomposed per concern**, one file per
extraction, as consumers need it. Each file here holds types that were declared in `app-state.ts`
and nothing more.

When `app-state.ts` itself is eventually ported (Phase 7, with the stores and UI), it should
**re-export from these modules** rather than redeclare them, so there is exactly one definition of
each type.

## Extracted so far

| Module | Types | Extracted for |
|---|---|---|
| `branches-state.ts` | `IBranchesState` | `lib/rebase.ts`, `lib/multi-commit-operation.ts` |
| `conflict-state.ts` | `MultiCommitOperationConflictState` | `models/multi-commit-operation.ts` |
| `constrained-value.ts` | `IConstrainedValue` | `lib/clamp.ts` |

## Still in `app-state.ts`, with known blockers

`app-state.ts` imports two things that must be extracted before it can be ported at all — both are
pure types used for two fields each, and both are recorded in `MIGRATION_MAP.md` §9:

- `IConfigValueOrigin` from `lib/git/config.ts` (the git layer, now Rust)
- `ApplicationTheme` / `ApplicableTheme` from `ui/lib/application-theme.ts`
