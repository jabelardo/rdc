import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  PreferencesState,
  PreferencesStore,
} from "@/features/preferences/stores/preferences-store";
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
    <PreferencesDialog state={{ ...state, ...overrides }} store={store} onDismiss={onDismiss} />,
  );
  return { store, onDismiss };
}

describe("PreferencesDialog", () => {
  it("opens on Appearance and routes its changes to the store", async () => {
    const user = userEvent.setup();
    const { store } = renderDialog({ theme: "light" });

    expect(screen.getByRole("dialog", { name: "Preferences" })).toBeInTheDocument();
    expect(screen.getByLabelText("Theme")).toHaveValue("light");

    await user.selectOptions(screen.getByLabelText("Theme"), "dark");

    expect(store.setTheme).toHaveBeenCalledWith("dark");
  });

  // Only the selected category's panel is mounted, which is the point of the layout: the dialog
  // does not grow with every setting rdc gains.
  it("shows one category at a time", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.getByLabelText("Theme")).toBeInTheDocument();
    expect(screen.queryByLabelText("Default merge")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Git" }));

    expect(screen.getByLabelText("Default merge")).toBeInTheDocument();
    expect(screen.queryByLabelText("Theme")).not.toBeInTheDocument();
  });

  it("routes a change made in another category", async () => {
    const user = userEvent.setup();
    const { store } = renderDialog({ defaultMergeStrategy: "squash" });

    await user.click(screen.getByRole("tab", { name: "Git" }));
    expect(screen.getByLabelText("Default merge")).toHaveValue("squash");
    await user.selectOptions(screen.getByLabelText("Default merge"), "merge");

    expect(store.setDefaultMergeStrategy).toHaveBeenCalledWith("merge");
  });

  // Radix supplies this from `orientation="vertical"`; the test is here because a horizontal
  // default would silently give left/right instead, and nobody would notice until they tried.
  it("moves between categories with the arrow keys", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("tab", { name: "Appearance" }));
    await user.keyboard("{ArrowDown}");

    expect(screen.getByRole("tab", { name: "Integrations" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByLabelText("External editor")).toBeInTheDocument();
  });

  it("closes through the explicit Close action", async () => {
    const user = userEvent.setup();
    const { onDismiss } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
