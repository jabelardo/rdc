import type { KeyboardEvent } from "react";

export function listNavigationTarget(
  key: string,
  currentIndex: number,
  length: number,
): number | null {
  if (length === 0) {
    return null;
  }
  switch (key) {
    case "ArrowDown":
      return Math.min(currentIndex + 1, length - 1);
    case "ArrowUp":
      return Math.max(currentIndex - 1, 0);
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return null;
  }
}

/**
 * Move a list's selection and focus in response to an arrow key.
 *
 * **The event must originate inside the list.** Without an explicit `focus` callback this locates
 * the next row by walking up from `event.currentTarget` to `[data-keyboard-list]`, so a handler
 * attached to a control *beside* the list — a filter field, say — finds nothing and moves focus
 * nowhere, silently. A control outside the list should either pass `focus`, or manage focus itself
 * and use {@linkcode listNavigationTarget} for the index arithmetic alone.
 */
export function handleListNavigation(
  event: KeyboardEvent<HTMLElement>,
  currentIndex: number,
  length: number,
  select: (targetIndex: number) => void,
  focus?: (targetIndex: number) => void,
): void {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  const target = listNavigationTarget(event.key, currentIndex, length);
  if (target === null) {
    return;
  }

  event.preventDefault();
  select(target);
  if (focus !== undefined) {
    focus(target);
    return;
  }
  const list = event.currentTarget.closest("[data-keyboard-list]");
  const indexedTarget = list?.querySelector<HTMLElement>(`[data-keyboard-list-index="${target}"]`);
  const positionalTarget = list?.querySelectorAll<HTMLElement>("[data-keyboard-list-item]")[target];
  const focusTarget = indexedTarget ?? positionalTarget;
  focusTarget?.focus();
}
