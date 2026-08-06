/**
 * How many paths to list before falling back to a bare count.
 *
 * desktop-plus's `MaxFilesToList`, ported as-is: past ten the list stops helping you recognise the
 * selection and starts pushing the buttons off a small window.
 */
const MaxFilesToList = 10;

/**
 * The question a discard-all confirmation asks, which depends on whether the paths will be listed.
 *
 * Kept separate from the list itself so it can be the dialog's accessible description — the list is
 * a `<ul>`, and a description renders as a `<p>`.
 */
export function discardAllQuestion(paths: ReadonlyArray<string>): string {
  return paths.length > MaxFilesToList
    ? `Are you sure you want to discard all ${paths.length} changed files?`
    : "Are you sure you want to discard all changes to:";
}

type DiscardFileListProps = {
  readonly paths: ReadonlyArray<string>;
};

/**
 * The paths a discard is about to affect, so a wrong selection can be caught while it is still
 * reversible. Renders nothing past the cap, where `discardAllQuestion` states a count instead.
 *
 * Paths wrap rather than truncate. desktop-plus middle-elides via `PathText` because it forces a
 * path onto one line; here there is room to wrap, and wrapping loses nothing. rdc's own
 * `truncateWithEllipsis` would be the wrong tool either way — it cuts the end, destroying the
 * filename, which is the part you need to recognise.
 */
export function DiscardFileList({ paths }: DiscardFileListProps) {
  if (paths.length > MaxFilesToList) {
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
