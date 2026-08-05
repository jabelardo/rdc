import { describe, expect, it } from "vitest";
import {
  AppMenu,
  findItemByAccessKey,
  getAccessKey,
  itemIsSelectable,
  type IMenu,
  type IMenuItem,
  type ISubmenuItem,
} from "./app-menu";

const normal = (id: string, label: string, overrides: Partial<IMenuItem> = {}): IMenuItem => ({
  id,
  type: "menuItem",
  label,
  enabled: true,
  visible: true,
  accessKey: getAccessKey(label),
  action: { type: "menu-event", event: "show-about" },
  ...overrides,
});

const fixture = (): IMenu => {
  const submenu: ISubmenuItem = {
    id: "file",
    type: "submenuItem",
    label: "&File",
    enabled: true,
    visible: true,
    accessKey: "F",
    menu: {
      id: "file",
      type: "menu",
      items: [
        normal("open", "&Open"),
        { id: "separator", type: "separator", visible: true },
        normal("disabled", "&Disabled", { enabled: false }),
      ],
    },
  };
  return { type: "menu", items: [submenu, normal("about", "&About")] };
};

describe("application menu model", () => {
  it("extracts access keys without treating escaped ampersands as prefixes", () => {
    expect(getAccessKey("Save && Upload")).toBeNull();
    expect(getAccessKey("Ben&&Jerrys")).toBeNull();
    expect(getAccessKey("Save && &Upload")).toBe("U");
    expect(getAccessKey("E&xit")).toBe("x");
  });

  it("finds access keys case-insensitively and leaves selectability to callers", () => {
    const items = fixture().items;
    expect(findItemByAccessKey("f", items)?.id).toBe("file");

    const disabled = (items[0] as ISubmenuItem).menu.items[2];
    expect(findItemByAccessKey("D", [disabled])?.id).toBe("disabled");
    expect(itemIsSelectable(disabled)).toBe(false);
  });

  it("tracks open menus and selection immutably", () => {
    const initial = AppMenu.fromMenu(fixture());
    const file = initial.getItemById("file") as ISubmenuItem;
    const opened = initial.withOpenedMenu(file, true);

    expect(initial.openMenus).toHaveLength(1);
    expect(opened.openMenus).toHaveLength(2);
    expect(opened.openMenus[0].selectedItem).toBeUndefined();
    expect(opened.openMenus[1].selectedItem?.id).toBe("open");

    const selected = opened.withSelectedItem(opened.getItemById("disabled")!);
    expect(selected.openMenus[0].selectedItem?.id).toBe("file");
    expect(selected.openMenus[1].selectedItem?.id).toBe("disabled");
    expect(opened.openMenus[1].selectedItem?.id).toBe("open");
  });

  it("preserves open and selected IDs when structure is refreshed", () => {
    const initial = AppMenu.fromMenu(fixture());
    const file = initial.getItemById("file") as ISubmenuItem;
    const opened = initial.withOpenedMenu(file).withSelectedItem(initial.getItemById("open")!);

    const replacement = fixture();
    const refreshed = opened.withMenu(replacement);

    expect(refreshed.openMenus.map((menu) => menu.id)).toEqual([undefined, "file"]);
    expect(refreshed.openMenus[1].selectedItem?.id).toBe("open");
    expect(refreshed.getItemById("open")).not.toBe(opened.getItemById("open"));
  });
});
