import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getDefaultPreferencesStore } from "@/features/preferences/stores/default-preferences-store";
import type { PreferencesState } from "@/features/preferences/stores/preferences-store";
import type { ThemeSource } from "@/platform/theme";

type ThemeContextValue = {
  readonly theme: ThemeSource;
  readonly resolvedTheme: "light" | "dark";
  readonly setTheme: (theme: ThemeSource) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * rdc's own answer to the `useTheme()` shape most shadcn snippets assume from `next-themes` —
 * same API, backed by the app's real preferences-store and Tauri-native theme integration
 * instead of a second, parallel theme system next-themes would otherwise bring in (and which has
 * no knowledge of `setNativeThemeSource`). Any shadcn-vendored component written against
 * `next-themes`' `useTheme()` needs only its import swapped to this module.
 *
 * Wrap the app once, near the root — see src/App.tsx.
 */
export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [store] = useState(getDefaultPreferencesStore);
  const [state, setState] = useState<PreferencesState>(store.state);

  useEffect(() => store.onDidUpdate(setState), [store]);

  const value: ThemeContextValue = {
    theme: state.theme,
    resolvedTheme: state.resolvedTheme,
    setTheme: (theme) => void store.setTheme(theme),
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
