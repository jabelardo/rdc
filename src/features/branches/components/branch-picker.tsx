import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, Search } from "lucide-react";
import type { Branch } from "@/models/branch";
import { Input } from "@/components/ui/input";
import { formatRelative } from "@/utils/format-relative";
import { formatTimestamp } from "@/utils/format-timestamp";
import { Tooltip } from "@/components/tooltip";
import { cn } from "@/lib/utils";
import { handleListNavigation } from "@/utils/list-navigation";

type BranchGroup = {
  readonly label: string;
  readonly branches: ReadonlyArray<Branch>;
};

type BranchPickerProps = {
  readonly branches: ReadonlyArray<Branch>;
  readonly defaultBranch: string | null;
  readonly recentBranches: ReadonlyArray<string>;
  readonly selectedBranch: Branch | null;
  /** Names the role the picked branch plays, which differs per operation. */
  readonly label: string;
  readonly onSelect: (branch: Branch) => void;
};

/**
 * Choose one branch, grouped and filterable.
 *
 * Replaces an earlier version that reused the sidebar's `.branch-list-selection` class. That class
 * is a three-column grid built for the sidebar's icon/name/badge row, and this row has four parts —
 * icon, name, remote badge, relative time — so the fourth wrapped onto a second line for every
 * remote branch. Its selected state also keys off `aria-current="true"`, which nothing here set, so
 * the picker showed no selection at all.
 *
 * Selection is `aria-selected` on a `listbox`/`option` pair rather than a list of buttons: the
 * control's purpose is choosing one of a set, and that is what a listbox means to a screen reader.
 */
export function BranchPicker({
  branches,
  defaultBranch,
  recentBranches,
  selectedBranch,
  label,
  onSelect,
}: BranchPickerProps) {
  const [filter, setFilter] = useState("");

  const groups = useMemo<ReadonlyArray<BranchGroup>>(() => {
    const query = filter.trim().toLocaleLowerCase();
    const matches = branches.filter((branch) => branch.name.toLocaleLowerCase().includes(query));
    const byName = new Map(matches.map((branch) => [branch.name, branch]));
    const taken = new Set<string>();

    const fallback = defaultBranch === null ? undefined : byName.get(defaultBranch);
    if (fallback !== undefined) {
      taken.add(fallback.name);
    }

    const recent = recentBranches
      .map((name) => byName.get(name))
      .filter((branch): branch is Branch => branch !== undefined && !taken.has(branch.name));
    for (const branch of recent) {
      taken.add(branch.name);
    }

    const rest = matches
      .filter((branch) => !taken.has(branch.name))
      .sort((left, right) => left.name.localeCompare(right.name));

    return [
      ...(fallback === undefined ? [] : [{ label: "Default branch", branches: [fallback] }]),
      ...(recent.length === 0 ? [] : [{ label: "Recent branches", branches: recent }]),
      ...(rest.length === 0 ? [] : [{ label: "Other branches", branches: rest }]),
    ];
  }, [filter, branches, defaultBranch, recentBranches]);

  // Groups are presentational; navigation runs over one flat order so Up and Down cross a group
  // heading rather than stopping at it.
  const ordered = useMemo(() => groups.flatMap((group) => group.branches), [groups]);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const restoreSelectionFocus = useRef(false);

  /**
   * Focus a row by index, scrolling it into view if it is not already.
   *
   * Passed explicitly to `handleListNavigation` rather than letting it find the row itself. Its
   * fallback walks up from the event target to the list, which works but ties navigation to DOM
   * structure; a ref cannot silently miss. `nearest` scrolls only when the row is actually out of
   * view, so stepping between visible rows does not yank the list around — the reason arrowing past
   * the last *visible* row now scrolls rather than appearing to jump elsewhere.
   */
  function focusIndex(index: number): void {
    const option = optionRefs.current[index];
    option?.focus();
    option?.scrollIntoView({ block: "nearest" });
  }

  // A selection click updates the parent, which can rerender the picker while the browser is still
  // completing the pointer sequence. WebKit may leave focus on the dialog in that case, so restore
  // focus after the selected row has been committed to the DOM. Arrow navigation itself focuses
  // directly through `focusIndex` and does not use this path.
  useLayoutEffect(() => {
    if (!restoreSelectionFocus.current || selectedBranch === null) {
      return;
    }
    const selectedIndex = ordered.findIndex((branch) => branch.name === selectedBranch.name);
    if (selectedIndex >= 0) {
      optionRefs.current[selectedIndex]?.focus();
    }
    restoreSelectionFocus.current = false;
  }, [ordered, selectedBranch]);

  /**
   * Arrow navigation, relative to the row the event came from.
   *
   * Rows stay individually focusable, so Tab still steps through them as it does in any list of
   * controls; the arrows are an addition rather than a replacement. Arrow handling is deliberately
   * absent from the filter field, where the arrows move the caret as they do in any text field.
   */
  function navigate(event: React.KeyboardEvent<HTMLElement>, index: number): void {
    handleListNavigation(
      event,
      index,
      ordered.length,
      (target) => {
        const branch = ordered[target];
        if (branch !== undefined) {
          onSelect(branch);
        }
      },
      focusIndex,
    );
  }

  return (
    <div className="grid gap-2">
      <label className="grid gap-1.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="relative">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            className="pl-8"
            placeholder="Filter branches"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          />
        </span>
      </label>
      <div
        className="max-h-[min(260px,40dvh)] overflow-y-auto rounded-[var(--radius-small)] border border-[var(--border)] bg-[var(--card)] p-1"
        role="listbox"
        aria-label={label}
      >
        {groups.length === 0 && (
          <p className="text-muted-foreground px-2 py-1.5 text-sm">No matching branches.</p>
        )}
        {groups.map((group) => (
          <div key={group.label}>
            <h3 className="text-muted-foreground px-2 py-1 text-xs font-medium">{group.label}</h3>
            {group.branches.map((branch) => {
              const selected = selectedBranch?.name === branch.name;
              const index = ordered.indexOf(branch);
              return (
                // The row truncates a long name and shows only a relative time, so the tooltip
                // carries the two facts the row cannot: the whole name, and the exact moment. Same
                // wording and format as the sidebar's branch rows.
                <Tooltip
                  key={branch.name}
                  label={`Full name: ${branch.name}\nLast modified: ${formatTimestamp(
                    branch.tip.author.date,
                  )}`}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    ref={(element) => {
                      optionRefs.current[index] = element;
                    }}
                    onKeyDown={(event) => navigate(event, index)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-[var(--radius-small)] border-transparent bg-transparent px-2 py-1.5 text-left text-sm shadow-none",
                      selected
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/60 hover:text-accent-foreground",
                    )}
                    onMouseDown={(event) => {
                      // WebKit does not consistently focus a button on an ordinary mouse click.
                      // The picker relies on the focused row as the origin for custom ArrowUp/
                      // ArrowDown navigation, so establish that focus before the click selects it.
                      event.currentTarget.focus();
                      restoreSelectionFocus.current = true;
                    }}
                    onClick={() => onSelect(branch)}
                  >
                    {/* Reserved whether or not it is shown, so rows do not shift as the selection
                     * moves between them. */}
                    <Check
                      className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")}
                      aria-hidden
                    />
                    {/* Remotes keep their prefix. Stripping it and adding a "remote" badge instead
                     * put two rows reading "develop" in the same list when a local branch and its
                     * remote counterpart were both candidates — the one place a picker must not be
                     * ambiguous. */}
                    <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {formatRelative(branch.tip.author.date.getTime() - Date.now())}
                    </span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
