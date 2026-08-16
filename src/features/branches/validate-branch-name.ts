import { sanitizedRefName } from "./sanitize-ref-name";

export type BranchNameValidation =
  /** Nothing typed yet. Not an error to shout about — the user is mid-edit. */
  | { readonly kind: "empty" }
  /** Same as the branch already has. Nothing to do, but nothing wrong either. */
  | { readonly kind: "unchanged" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "valid" };

type ValidateOptions = {
  /** The branch's existing name, so "no change" is distinguished from "bad name". */
  readonly currentName: string;
  /** Every local branch name, for detecting a collision before git does. */
  readonly existingNames: ReadonlyArray<string>;
};

/**
 * Whether a proposed branch name can be used, and if not, why in words.
 *
 * rdc previously blocked only the empty and unchanged cases, so anything else — a space, a `~`, a
 * name already taken — reached git and came back as a failure after the fact. `sanitizedRefName`
 * was already ported for exactly this and had no callers.
 *
 * The messages name the specific rule rather than saying "invalid", because "invalid branch name"
 * leaves the user guessing which character to remove. Rule order matters: the most likely mistake
 * (a space) is reported ahead of the general character rule that would also catch it.
 */
export function validateBranchName(
  proposed: string,
  { currentName, existingNames }: ValidateOptions,
): BranchNameValidation {
  const name = proposed.trim();

  if (name.length === 0) {
    return { kind: "empty" };
  }
  if (name === currentName) {
    return { kind: "unchanged" };
  }
  if (proposed.includes(" ")) {
    return { kind: "invalid", message: "A branch name cannot contain spaces." };
  }
  if (name.includes("..")) {
    return { kind: "invalid", message: "A branch name cannot contain two consecutive dots." };
  }
  if (name.startsWith(".") || name.endsWith(".")) {
    return { kind: "invalid", message: "A branch name cannot start or end with a dot." };
  }
  if (name.endsWith(".lock")) {
    return { kind: "invalid", message: "A branch name cannot end with “.lock”." };
  }
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) {
    return { kind: "invalid", message: "A branch name cannot start, end, or double up on “/”." };
  }
  if (name.includes("@{")) {
    return { kind: "invalid", message: "A branch name cannot contain the sequence “@{”." };
  }
  // The catch-all, last: every rule above describes its own case more precisely than this can.
  if (sanitizedRefName(name) !== name) {
    return {
      kind: "invalid",
      message: "A branch name cannot contain ~ ^ : ? * [ \\ or control characters.",
    };
  }
  if (existingNames.includes(name)) {
    return { kind: "invalid", message: `A branch named “${name}” already exists.` };
  }

  return { kind: "valid" };
}
