import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

// Phase 0 wiring smoke test only — this scaffold component is replaced in
// Phase 7 (UI migration), at which point this test is replaced too.
describe("App scaffold", () => {
  it("renders without crashing", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: /welcome to tauri \+ react/i })
    ).toBeInTheDocument();
  });
});
