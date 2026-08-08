/**
 * A local `YYYY-MM-DD HH:MM` timestamp.
 *
 * Absolute, deliberately: it accompanies a relative time like "3 days ago" rather than replacing it,
 * and the whole point of showing both is that one is readable at a glance while the other is exact.
 *
 * Local rather than UTC, because the reader is comparing it against their own recollection of when
 * they did something.
 */
export function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
