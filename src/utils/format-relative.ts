// Ported from desktop-plus/app/src/lib/format-relative.ts. The upstream helper caches formatters
// through `mem`; one module-scoped formatter gives RDC the same behavior without another utility
// dependency.
const formatter = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

/** Format a millisecond offset from now as a compact human relative time. */
export function formatRelative(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) {
    return "Invalid date";
  }

  const sign = milliseconds < 0 ? -1 : 1;
  const seconds = Math.round(Math.abs(milliseconds) / 1_000);
  const minutes = Math.round(seconds / 60);
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);
  const months = Math.round(days / 30);
  const years = Math.round(months / 12);

  if (seconds < 45) {
    return formatter.format(seconds * sign, "second");
  }
  if (minutes < 45) {
    return formatter.format(minutes * sign, "minute");
  }
  if (hours < 24) {
    return formatter.format(hours * sign, "hour");
  }
  if (days < 30) {
    return formatter.format(days * sign, "day");
  }
  if (months < 18) {
    return formatter.format(months * sign, "month");
  }
  return formatter.format(years * sign, "year");
}
