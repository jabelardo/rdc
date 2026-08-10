import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PreferencesState, PreferencesStore } from "../../stores/preferences-store";
import { PreferencesDialog } from "./preferences-dialog";

const state: PreferencesState = {
  theme: "system",
  resolvedTheme: "light",
  zoomFactor: 1,
  confirmRepositoryRemoval: true,
  confirmDiscardChanges: true,
  confirmDiscardChangesPermanently: true,
  defaultMergeStrategy: "merge",
  selectedExternalEditor: null,
  selectedShell: null,
  editors: [],
  shells: [],
  loading: false,
  error: null,
};

function renderDialog(overrides: Partial<PreferencesState> = {}) {
  const store = {
    setTheme: vi.fn(),
    setDefaultMergeStrategy: vi.fn(),
    setConfirmRepositoryRemoval: vi.fn(),
    setConfirmDiscardChanges: vi.fn(),
    setConfirmDiscardChangesPermanently: vi.fn(),
    setSelectedExternalEditor: vi.fn(),
    setSelectedShell: vi.fn(),
    setZoomFactor: vi.fn(),
  } as unknown as PreferencesStore;
  const onDismiss = vi.fn();
  render(
    <PreferencesDialog
      state={{ ...state, ...overrides }}
      store={store}
      onDismiss={onDismiss}
    />,
  );
  return { store, onDismiss };
}

describe("PreferencesDialog", () => {
  it("renders the persisted settings and routes changes to the store", async () => {
    const user = userEvent.setup();
    const { store } = renderDialog({ theme: "light", defaultMergeStrategy: "squash" });

    expect(screen.getByRole("dialog", { name: "Preferences" })).toBeInTheDocument();
    expect(screen.getByLabelText("Theme")).toHaveValue("light");
    expect(screen.getByLabelText("Default merge")).toHaveValue("squash");

    await user.selectOptions(screen.getByLabelText("Theme"), "dark");
    await user.selectOptions(screen.getByLabelText("Default merge"), "merge");

    expect(store.setTheme).toHaveBeenCalledWith("dark");
    expect(store.setDefaultMergeStrategy).toHaveBeenCalledWith("merge");
  });

  it("closes through the explicit Close action", async () => {
    const user = userEvent.setup();
    const { onDismiss } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
