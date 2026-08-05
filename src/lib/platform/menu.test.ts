import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_command: string, _args?: unknown) => undefined));
const listen = vi.hoisted(() => vi.fn());
const getCurrentWindowZoomFactor = vi.hoisted(() => vi.fn(async () => 1));

type WireItem =
  | { readonly type: "item"; readonly id: string; readonly label: string }
  | { readonly type: "separator" };

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("./window", () => ({ getCurrentWindowZoomFactor }));

const { showContextMenu } = await import("./menu");

/** Captures the registered handler so a test can deliver a selection itself. */
function captureListener() {
  const captured: {
    handler?: (event: { payload: string }) => void;
    unlisten: ReturnType<typeof vi.fn>;
  } = { unlisten: vi.fn() };
  listen.mockImplementation((_event, callback) => {
    captured.handler = callback;
    return Promise.resolve(captured.unlisten);
  });
  return captured;
}

function popupArgs(): { x: number; y: number; items: ReadonlyArray<WireItem> } {
  return invoke.mock.calls[0][1] as {
    x: number;
    y: number;
    items: ReadonlyArray<WireItem>;
  };
}

/** The id Rust would report for the item at `index`, whose token this side generated. */
function wireIdAt(index: number): string {
  return popupArgs().items.flatMap((item) => (item.type === "item" ? [item.id] : []))[index];
}

describe("showContextMenu", () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined);
    listen.mockReset().mockResolvedValue(vi.fn());
    getCurrentWindowZoomFactor.mockReset().mockResolvedValue(1);
  });

  it("sends wire items, and separators carry no id", async () => {
    await showContextMenu(
      [
        { text: "Open", action: vi.fn() },
        { type: "separator" },
        { text: "Remove", enabled: false },
      ],
      { x: 12, y: 34 },
    );

    expect(invoke).toHaveBeenCalledWith("show_context_menu_at", {
      x: 12,
      y: 34,
      items: [
        { type: "item", id: expect.any(String), label: "Open", enabled: true },
        { type: "separator" },
        {
          type: "item",
          id: expect.any(String),
          label: "Remove",
          enabled: false,
        },
      ],
    });
  });

  // The webview reports zoom-invariant CSS pixels, so anchoring at a non-default zoom needs them
  // scaled — the Rust side cannot do it, since the zoom factor lives here.
  it("scales the position by the window zoom factor", async () => {
    getCurrentWindowZoomFactor.mockResolvedValue(1.5);

    await showContextMenu([{ text: "Open" }], { x: 100, y: 200 });

    expect(popupArgs()).toMatchObject({ x: 150, y: 300 });
  });

  it("runs the action of the selected item and no other", async () => {
    const captured = captureListener();
    const open = vi.fn();
    const remove = vi.fn();

    await showContextMenu(
      [
        { text: "Open", action: open },
        { text: "Remove", action: remove },
      ],
      { x: 0, y: 0 },
    );
    captured.handler?.({ payload: wireIdAt(1) });

    expect(open).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
  });

  // Ids are broadcast, not addressed to one window, so a menu in another window must be ignored
  // rather than firing this menu's action at the same index.
  it("ignores a selection whose id it did not issue", async () => {
    const captured = captureListener();
    const action = vi.fn();

    await showContextMenu([{ text: "Open", action }], { x: 0, y: 0 });
    captured.handler?.({ payload: "someothertoken-0" });

    expect(action).not.toHaveBeenCalled();
  });

  it("stops listening once an item has been chosen", async () => {
    const captured = captureListener();

    await showContextMenu([{ text: "Open", action: vi.fn() }], { x: 0, y: 0 });
    expect(captured.unlisten).not.toHaveBeenCalled();

    captured.handler?.({ payload: wireIdAt(0) });

    expect(captured.unlisten).toHaveBeenCalledOnce();
  });

  // Dismissing a menu produces no event on Linux, by design — the popup is fire-and-forget — so
  // opening the next one is what has to release the abandoned listener.
  it("releases the previous listener when another menu opens", async () => {
    const first = captureListener();
    await showContextMenu([{ text: "Open", action: vi.fn() }], { x: 0, y: 0 });

    const second = captureListener();
    await showContextMenu([{ text: "Rename", action: vi.fn() }], { x: 0, y: 0 });

    expect(first.unlisten).toHaveBeenCalledOnce();
    expect(second.unlisten).not.toHaveBeenCalled();
  });

  // Two triggers can overlap — a double-click on a row's "more actions" button. Showing a menu
  // takes several IPC round-trips, so without queueing the two could reach Rust in either order,
  // and the popup that won might be the one whose ids nobody is listening for: a menu on screen
  // where every item silently does nothing.
  it("serializes overlapping opens rather than interleaving their round-trips", async () => {
    const order: string[] = [];
    listen.mockImplementation(() => {
      order.push("listen");
      return Promise.resolve(vi.fn());
    });
    invoke.mockImplementation(async () => {
      order.push("invoke");
      return undefined;
    });

    await Promise.all([
      showContextMenu([{ text: "Open" }], { x: 0, y: 0 }),
      showContextMenu([{ text: "Rename" }], { x: 0, y: 0 }),
    ]);

    expect(order).toEqual(["listen", "invoke", "listen", "invoke"]);
  });

  it("does nothing for empty items", async () => {
    await showContextMenu([], { x: 0, y: 0 });

    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });
});
