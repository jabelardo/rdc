/**
 * Regular expressions matching textual issue references (`#123`, `gh-123`,
 * `owner/repo#123`, `/issues/123`, …).
 *
 * MIGRATION NOTE (layering fix): in desktop-plus these lived in
 * `lib/markdown-filters/issue-mention-filter.ts`, next to the `IssueMentionFilter` class.
 * `lib/pull-request-refs.ts` imports only `IssueReference` — a `RegExp` value, so it cannot be
 * erased at compile time like a type — and that pulled in the filter class, which imports
 * `node-filter.ts`, which constructs the whole filter pipeline including `EmojiFilter`, which reads
 * PNG files off disk with `fs/promises`. Four hops from a regex to Node filesystem access.
 *
 * The patterns are shared data with no dependencies, so they live on their own. When
 * `issue-mention-filter.ts` is ported with the markdown UI in Phase 7 it should import them from
 * here rather than redeclaring them.
 */

/**
 * A regular expression to match a group of any digit follow by a word
 * bounding character.
 * Example: 123 or 123.
 */
export const IssueRefNumber = /(?<refNumber>\d+)\b/;

/**
 * A regular expression to match a group of an repo name or name with owner
 * Example: desktop/dugite or desktop
 */
export const IssueOwnerOrOwnerRepo = /(?<ownerOrOwnerRepo>\w+(?:-\w+)*(?:\/[.\w-]+)?)/;

/**
 * A regular expression to match a group possible of preceding markers are
 * gh-, #, /issues/, /pull/, or /discussions/ followed by a digit
 */
export const IssueMentionMarker = /(?<marker>#|gh-|\/(?:issues|pull|discussions)\/)(?=\d)/i;

/**
 * A regular expression string of a lookbehind is used so that valid matches
 * for the issue reference have the leader precede them but the leader is not
 * considered part of the match. An issue reference much have a whitespace,
 * beginning of line, or some other non-word character must precede it.
 */
export const IssueMentionLeader = /(?<=^|\W)/;

/**
 * A regular expression matching an issue reference. Issue reference must:
 * 1) Start with an issue marker: gh-, #, /issues/, /pull/, or /discussions/
 * 2) The issue marker must be followed by a number
 * 3) The number must end in a word bounding character. Additionally, the
 *    issue reference match may be such that the marker may be preceded by a
 *    repo references of owner/repo or owner
 */
export const IssueReference = new RegExp(
  IssueOwnerOrOwnerRepo.source + "?" + IssueMentionMarker.source + IssueRefNumber.source,
  "i",
);
