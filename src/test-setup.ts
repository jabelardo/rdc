import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'

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
})
