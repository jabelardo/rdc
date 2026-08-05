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
