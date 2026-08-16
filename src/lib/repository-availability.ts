import type { RepositoryType } from "@/models/repository-type";

/**
 * Whether the selected repository can still be read, and what to say when it cannot.
 *
 * This exists because five stores each load the same repository with their own git command. When
 * the directory is deleted out from under the app, every one of them discovers it independently and
 * reports it in its own words — Phase 8b cycle 2 photographed two toasts naming `getBranches` and
 * `getStatus` plus an inline block, all from one deleted directory. Coalescing cannot merge those:
 * they are different sentences.
 *
 * So the question is asked once, before the loads, and the answer is phrased here rather than by
 * whichever git command happened to fail first. `failed to run git for 'getBranches' in …
 * (os error 2)` is a developer sentence; it should never have been a user-facing one.
 */
export type RepositoryAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly message: string };

const Available: RepositoryAvailability = { available: true };

/**
 * Classifies a repository for the person using it, given what `getRepositoryType` found.
 *
 * `name` is preferred over the full path: the path is usually long, the toast is narrow, and the
 * user picked the repository by name.
 */
export function repositoryAvailability(name: string, type: RepositoryType): RepositoryAvailability {
  switch (type.kind) {
    case "regular":
      return Available;
    case "missing":
      return {
        available: false,
        message: `${name} is no longer available. It may have been moved, renamed or deleted.`,
      };
    case "bare":
      return {
        available: false,
        message: `${name} is a bare repository, which has no working tree to show.`,
      };
    case "unsafe":
      return {
        available: false,
        message: `${name} is owned by another user, so Git refuses to open it.`,
      };
  }
}
