/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// Compile-time constants that the ported desktop-plus code expects. These were
// injected by webpack's DefinePlugin in the original app (see
// desktop-plus/app/webpack.common.ts); Vite's `define` is the direct equivalent
// and also applies under Vitest, so verbatim-ported tests see them too.
// See src/globals.d.ts for the type declarations.
const lit = (v: unknown) => JSON.stringify(v);
// An env-provided secret, or the literal `undefined` when unset — these are
// declared `string | undefined`, so the replacement text must be valid JS.
const envOrUndefined = (name: string) =>
  process.env[name] ? lit(process.env[name]) : "undefined";

// Tauri sets TAURI_ENV_PLATFORM during `tauri dev`/`tauri build`; fall back to
// the host platform so plain `vite`/`vitest` runs still resolve sensibly.
const platform = process.env.TAURI_ENV_PLATFORM ?? process.platform;
const isDev = process.env.NODE_ENV !== "production";

const buildTimeGlobals = {
  __DEV__: lit(isDev),
  __DEV_SECRETS__: lit(isDev),
  __RELEASE_CHANNEL__: lit(process.env.RELEASE_CHANNEL ?? "development"),
  __DARWIN__: lit(platform === "darwin" || platform === "macos"),
  __WIN32__: lit(platform === "win32" || platform === "windows"),
  __LINUX__: lit(platform === "linux"),
  __APP_NAME__: lit("rdc"),
  __APP_VERSION__: lit(process.env.npm_package_version ?? "0.1.0"),
  __OAUTH_CLIENT_ID__: envOrUndefined("DESKTOP_OAUTH_CLIENT_ID"),
  __OAUTH_SECRET__: envOrUndefined("DESKTOP_OAUTH_CLIENT_SECRET"),
  __OAUTH_CLIENT_ID_BITBUCKET__: envOrUndefined("DESKTOP_OAUTH_CLIENT_ID_BITBUCKET"),
  __OAUTH_SECRET_BITBUCKET__: envOrUndefined("DESKTOP_OAUTH_CLIENT_SECRET_BITBUCKET"),
  __OAUTH_CLIENT_ID_GITLAB__: envOrUndefined("DESKTOP_OAUTH_CLIENT_ID_GITLAB"),
  __OAUTH_SECRET_GITLAB__: envOrUndefined("DESKTOP_OAUTH_CLIENT_SECRET_GITLAB"),
  __OAUTH_CLIENT_ID_CODEBERG__: envOrUndefined("DESKTOP_OAUTH_CLIENT_ID_CODEBERG"),
  __OAUTH_SECRET_CODEBERG__: envOrUndefined("DESKTOP_OAUTH_CLIENT_SECRET_CODEBERG"),
};

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],
  define: buildTimeGlobals,

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // Env variables starting with the item of `envPrefix` will be exposed in tauri's source code through `import.meta.env`.
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    target: process.platform === "win32" ? "chrome105" : "safari13",
    // don't minify for debug builds
    minify: process.env.TAURI_ENV_DEBUG ? false : ("esbuild" as const),
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    css: false,
    exclude: ["**/node_modules/**", "**/src-tauri/**"],
  },
}));
