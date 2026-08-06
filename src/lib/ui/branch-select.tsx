import { useMemo, useState } from "react";
import { Check, GitBranch, Search } from "lucide-react";
import { Branch, BranchType } from "../../models/branch";
import { formatRelative } from "../format-relative";

type BranchSelectEntry = {
  readonly branch: Branch;
  readonly group: "default" | "recent" | "other";
};

type BranchSelectProps = {
  readonly branches: ReadonlyArray<Branch>;
  readonly currentBranch: string | null;
  readonly defaultBranch: string | null;
  readonly recentBranches: ReadonlyArray<string>;
  readonly selectedBranch: Branch | null;
  readonly onSelect: (branch: Branch) => void;
};

export function BranchSelect({
  branches,
  currentBranch,
  defaultBranch,
  recentBranches,
  selectedBranch,
  onSelect,
}: BranchSelectProps) {
  const [filter, setFilter] = useState("");

  const entries = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    const byName = new Map(branches.map((b) => [b.name, b]));
    const assigned = new Set<string>();
    const result = new Array<BranchSelectEntry>();

    const def = defaultBranch === null ? undefined : byName.get(defaultBranch);
    if (def !== undefined) {
      result.push({ branch: def, group: "default" });
      assigned.add(def.name);
    }

    for (const name of recentBranches) {
      const branch = byName.get(name);
      if (branch !== undefined && !assigned.has(branch.name)) {
        result.push({ branch, group: "recent" });
        assigned.add(branch.name);
      }
    }

    for (const branch of branches
      .filter((b) => !assigned.has(b.name))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      result.push({ branch, group: "other" });
    }

    return result.filter((e) => e.branch.name.toLocaleLowerCase().includes(query));
  }, [filter, branches, defaultBranch, recentBranches]);

  const grouped = useMemo(() => {
    const groups = new Array<{
      readonly label: string;
      readonly entries: ReadonlyArray<BranchSelectEntry>;
    }>();

    const defaultEntries = entries.filter((e) => e.group === "default");
    if (defaultEntries.length > 0) {
      groups.push({ label: "Default branch", entries: defaultEntries });
    }

    const recentEntries = entries.filter((e) => e.group === "recent");
    if (recentEntries.length > 0) {
      groups.push({ label: "Recent branches", entries: recentEntries });
    }

    const otherEntries = entries.filter((e) => e.group === "other");
    if (otherEntries.length > 0) {
      groups.push({ label: "Other branches", entries: otherEntries });
    }

    return groups;
  }, [entries]);

  return (
    <div className="grid gap-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          type="search"
          className="flex h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 py-1 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          placeholder="Filter"
          aria-label="Filter branches"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
      </div>
      <div className="grid max-h-[300px] gap-0.5 overflow-y-auto rounded-md border border-[var(--border)] p-1">
        {grouped.length === 0 && (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">No matching branches</p>
        )}
        {grouped.map((group) => (
          <div key={group.label}>
            <h3 className="px-2 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground">
              {group.label}
            </h3>
            {group.entries.map(({ branch }) => {
              const isCurrent = branch.name === currentBranch;
              const isSelected = selectedBranch?.name === branch.name;
              const isRemote = branch.type === BranchType.Remote;
              const Icon = isCurrent ? Check : GitBranch;
              return (
                <button
                  key={branch.name}
                  type="button"
                  className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground ${isSelected ? "bg-accent text-accent-foreground" : ""}`}
                  onClick={() => onSelect(branch)}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 truncate">
                    {isRemote ? branch.nameWithoutRemote : branch.name}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {formatRelative(branch.tip.author.date.getTime() - Date.now())}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
