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
