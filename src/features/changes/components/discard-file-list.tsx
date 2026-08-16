import { VirtualList } from "@/components/virtual-list";

/**
 * The question a discard-all confirmation asks.
 *
 * The file count appears in every form of it — it is the one fact that tells you the scale of what
 * you are about to lose, and a list you have to count yourself does not convey it. Kept separate from
 * the list so it can be the dialog's accessible description: the list is a `<ul>`, and a description
 * renders as a `<p>`.
 */
export function discardAllQuestion(fileCount: number): string {
  return fileCount === 1
    ? "Are you sure you want to discard all changes to this 1 file:"
    : `Are you sure you want to discard all changes to these ${fileCount} files:`;
}

type DiscardFileListProps = {
  readonly paths: ReadonlyArray<string>;
};

/**
 * Every path a discard is about to affect, in a fixed-height scroll region.
 *
 * There is deliberately **no cap**. An earlier version listed ten paths and then showed a count
 * alone, which meant a hundred-file discard told you nothing about which files it covered — the
 * point at which you most want to check. Bounding the height instead costs the same vertical space
 * whether there are ten paths or ten thousand, and `VirtualList` windows the DOM past a hundred rows
 * on its own, so the large case is not paid for by the small one.
 *
 * Paths wrap rather than truncate. desktop-plus middle-elides via `PathText` because it forces a
 * path onto one line; wrapping loses nothing. rdc's own `truncateWithEllipsis` would be the wrong
 * tool either way — it cuts the end, destroying the filename, which is the part you recognise.
 */
export function DiscardFileList({ paths }: DiscardFileListProps) {
  if (paths.length === 0) {
    return null;
  }

  return (
    <div className="rounded-[var(--radius-small)] border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 [&>.virtual-list-viewport]:max-h-[240px]">
      <VirtualList
        items={paths}
        className="m-0 list-none p-0"
        ariaLabel="Files to discard"
        estimateSize={() => 18}
        getItemKey={(path) => path}
      >
        {(path, _index, row) => (
          <li
            ref={row.measureElement}
            data-index={row.virtualIndex}
            style={row.style}
            className="font-mono [overflow-wrap:anywhere]"
          >
            {path}
          </li>
        )}
      </VirtualList>
    </div>
  );
}
