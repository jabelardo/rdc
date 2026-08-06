/**
 * How many paths to list before falling back to a count alone.
 *
 * desktop-plus's `MaxFilesToList`, ported as-is: past ten the list stops helping you recognise the
 * selection and starts pushing the buttons off a small window.
 */
export const MaxFilesToList = 10;

/**
 * The question a discard-all confirmation asks.
 *
 * The file count appears in **every** form of the question, listed or not — it is the one fact that
 * tells you the scale of what you are about to lose, and a list you have to count yourself does not
 * convey it. Kept separate from the list itself so it can be the dialog's accessible description:
 * the list is a `<ul>`, and a description renders as a `<p>`.
 */
export function discardAllQuestion(fileCount: number): string {
  if (fileCount > MaxFilesToList) {
    return `Are you sure you want to discard all changes to ${fileCount} changed files?`;
  }
  return fileCount === 1
    ? "Are you sure you want to discard all changes to this 1 file:"
    : `Are you sure you want to discard all changes to these ${fileCount} files:`;
}

type DiscardFileListProps = {
  readonly paths: ReadonlyArray<string>;
  readonly fileCount: number;
};

/**
 * The paths a discard is about to affect, so a wrong selection can be caught while it is still
 * reversible. Renders nothing past the cap, where `discardAllQuestion` states the count alone.
 *
 * Paths wrap rather than truncate. desktop-plus middle-elides via `PathText` because it forces a
 * path onto one line; here there is room to wrap, and wrapping loses nothing. rdc's own
 * `truncateWithEllipsis` would be the wrong tool either way — it cuts the end, destroying the
 * filename, which is the part you need to recognise.
 */
export function DiscardFileList({ paths, fileCount }: DiscardFileListProps) {
  if (fileCount > MaxFilesToList) {
    return null;
  }

  return (
    <ul className="max-h-[240px] list-none overflow-y-auto pl-0">
      {paths.map((path) => (
        <li key={path} className="font-mono [overflow-wrap:anywhere]">
          {path}
        </li>
      ))}
    </ul>
  );
}
