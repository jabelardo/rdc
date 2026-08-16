import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreferencesState } from "@/features/preferences/stores/preferences-store";
import { ThemeProvider, useTheme } from "./theme-provider";

type Listener = (state: PreferencesState) => void;

const store = vi.hoisted(() => {
  let state: PreferencesState = {
    theme: "system",
    resolvedTheme: "dark",
    zoomFactor: 1,
    confirmRepositoryRemoval: true,
    confirmDiscardChanges: true,
    confirmDiscardChangesPermanently: true,
    defaultMergeStrategy: "merge" as const,
    selectedExternalEditor: null,
    selectedShell: null,
    editors: [],
    shells: [],
    loading: false,
    error: null,
  };
  const listeners = new Set<Listener>();
  const update = (next: Partial<PreferencesState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) {
      listener(state);
    }
  };
  return {
    get state() {
      return state;
    },
    onDidUpdate: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTheme: vi.fn(async (theme: "light" | "dark" | "system") => {
      update({ theme });
      update({ resolvedTheme: theme === "system" ? "dark" : theme });
    }),
    reset: () => {
      state = { ...state, theme: "system", resolvedTheme: "dark" };
    },
  };
});

vi.mock("@/features/preferences/stores/default-preferences-store", () => ({
  getDefaultPreferencesStore: () => store,
}));

describe("useTheme", () => {
  beforeEach(() => {
    store.reset();
    store.setTheme.mockClear();
  });

  it("throws when used outside a ThemeProvider", () => {
    expect(() => renderHook(() => useTheme())).toThrow(/ThemeProvider/);
  });

  it("exposes the store's current theme and resolvedTheme", () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    expect(result.current.theme).toBe("system");
    expect(result.current.resolvedTheme).toBe("dark");
  });

  it("routes setTheme through the store", async () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    await act(async () => {
      result.current.setTheme("light");
      await Promise.resolve();
    });

    expect(store.setTheme).toHaveBeenCalledWith("light");
    expect(result.current.theme).toBe("light");
    expect(result.current.resolvedTheme).toBe("light");
  });

  it("stays in sync with a theme change made through the store directly", async () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    await act(() => store.setTheme("light"));

    expect(result.current.theme).toBe("light");
    expect(result.current.resolvedTheme).toBe("light");
  });
});
