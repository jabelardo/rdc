import { beforeEach, describe, expect, it, vi } from "vitest";
import snapshot from "@/lib/__generated__/wire-snapshot.json";
import type { MenuKeybindings } from "@/models/keybinding";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const { getKeybindings, onKeybindingsChanged, resetKeybindings, setKeybinding } =
  await import("./keybindings");

describe("keybinding wire contract", () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
  });

  it("matches the Rust serializer for a menu-keyed structured binding map", () => {
    const keybindings: MenuKeybindings = {
      pull: {
        modifiers: ["control", "shift"],
        key: "KeyP",
      },
    };

    expect(snapshot.keybindings).toEqual(keybindings);
  });

  it("uses typed get, set, and reset commands", async () => {
    const keybindings: MenuKeybindings = {
      pull: { modifiers: ["control", "shift"], key: "KeyK" },
    };
    invoke.mockResolvedValue(keybindings);

    await expect(getKeybindings()).resolves.toBe(keybindings);
    await expect(setKeybinding("pull", keybindings.pull!)).resolves.toBe(keybindings);
    await expect(resetKeybindings()).resolves.toBe(keybindings);

    expect(invoke).toHaveBeenNthCalledWith(1, "get_keybindings");
    expect(invoke).toHaveBeenNthCalledWith(2, "set_keybinding", {
      menuId: "pull",
      binding: keybindings.pull,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "reset_keybindings");
  });

  it("unwraps the changed event payload", async () => {
    const keybindings: MenuKeybindings = {
      push: { modifiers: ["control"], key: "KeyK" },
    };
    const callback = vi.fn();
    listen.mockImplementation(async (_eventName: string, handler: (event: unknown) => void) => {
      handler({ payload: keybindings });
      return vi.fn();
    });

    await onKeybindingsChanged(callback);

    expect(listen).toHaveBeenCalledWith("keybindings-changed", expect.any(Function));
    expect(callback).toHaveBeenCalledWith(keybindings);
  });
});
