import { describe, expect, it } from "vitest";
import { acceleratorDeclarations, explicitMenuIds } from "./measure-menu-accelerators.mjs";

describe("measure-menu-accelerators", () => {
  it("extracts explicit, role-based, and generated stable ids", () => {
    expect(
      acceleratorDeclarations(`
        const menu = [
          { id: 'open', accelerator: 'CmdOrCtrl+O' },
          { role: 'quit', accelerator: exitAccelerator },
          { label: darwin ? 'Select All' : 'Select &all', accelerator: 'CmdOrCtrl+A' },
        ]
      `),
    ).toEqual([
      "open=CmdOrCtrl+O",
      "quit=macos:Command+Q|windows:Alt+F4|other:CmdOrCtrl+Q",
      "select-all=CmdOrCtrl+A",
    ]);
  });
});

describe("explicitMenuIds", () => {
  it("collects only literal id properties", () => {
    const source = `
      const items = [
        { id: 'push', label: 'Push' },
        { id: dynamicId },
        { action: { type: 'menu-event', event: 'pull' } },
      ]
    `;

    expect([...explicitMenuIds(source)]).toEqual(["push"]);
  });
});
