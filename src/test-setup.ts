import { vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";

// jsdom has no `window.matchMedia` at all — sonner's <Toaster> (src/components/ui/sonner.tsx)
// calls it on mount to track the OS color-scheme preference, and throws without this stub.
// `matches: false` is an arbitrary fixed answer; no test in this suite depends on a real
// prefers-color-scheme result, since the app passes its own resolved theme explicitly.
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => false,
  }) as MediaQueryList;

// jsdom does not implement Element.prototype.scrollIntoView — nothing lays out, so there is
// nothing to scroll to. The branch picker's keyboard navigation calls it on the focused row,
// which threw "not a function" inside the event handler for every arrow-key test and produced
// Vitest's unhandled-error noise (which it explicitly warns can cause false-positive failures
// in other files running in parallel). A no-op stub keeps the navigation contract under test
// without pretending jsdom performs layout.
Element.prototype.scrollIntoView ??= () => {};

// The ambient `log` global is a runtime object (unlike the __FOO__ constants,
// which Vite's `define` substitutes at build time). Tests get a no-op
// implementation, matching desktop-plus/app/test/globals.mts, so ported code
// that logs doesn't blow up or spam test output.
Object.assign(globalThis, {
  log: {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  },
});
