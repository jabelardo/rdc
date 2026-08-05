/* eslint-disable @typescript-eslint/naming-convention */

// Compile-time constants, substituted by Vite's `define` (see vite.config.ts).
// Ported from desktop-plus/app/src/lib/globals.d.ts, trimmed to what rdc
// actually references — the Electron/NodeJS namespace augmentations from the
// original are deliberately omitted since neither applies to Tauri.

/** Is the app running in dev mode? */
declare const __DEV__: boolean;

/** Is the app using dev secrets? */
declare const __DEV_SECRETS__: boolean;

/** The OAuth client id the app should use */
declare const __OAUTH_CLIENT_ID__: string | undefined;

/** The OAuth secret the app should use. */
declare const __OAUTH_SECRET__: string | undefined;

/** The OAuth client id the app should use for Bitbucket */
declare const __OAUTH_CLIENT_ID_BITBUCKET__: string | undefined;

/** The OAuth secret the app should use for Bitbucket */
declare const __OAUTH_SECRET_BITBUCKET__: string | undefined;

/** The OAuth client id the app should use for GitLab */
declare const __OAUTH_CLIENT_ID_GITLAB__: string | undefined;

/** The OAuth secret the app should use for GitLab */
declare const __OAUTH_SECRET_GITLAB__: string | undefined;

/** The OAuth client id the app should use for Codeberg */
declare const __OAUTH_CLIENT_ID_CODEBERG__: string | undefined;

/** The OAuth secret the app should use for Codeberg */
declare const __OAUTH_SECRET_CODEBERG__: string | undefined;

/** Is the app being built to run on Darwin? */
declare const __DARWIN__: boolean;

/** Is the app being built to run on Win32? */
declare const __WIN32__: boolean;

/** Is the app being built to run on Linux? */
declare const __LINUX__: boolean;

/**
 * The product name of the app. Compile-time replacement for what was
 * Electron's app.getName().
 */
declare const __APP_NAME__: string;

/**
 * The current version of the app. Compile-time replacement for what was
 * Electron's app.getVersion().
 */
declare const __APP_VERSION__: string;

/** The channel for which the release was created. */
declare const __RELEASE_CHANNEL__: "production" | "beta" | "test" | "development";

interface IDesktopLogger {
  /**
   * Writes a log message at the 'error' level.
   *
   * @param message The text to write to the log
   * @param error   An optional error instance that will be formatted to
   *                include the stack trace (if one is available) and
   *                then appended to the log message.
   */
  error(message: string, error?: Error): void;

  /** Writes a log message at the 'warn' level. */
  warn(message: string, error?: Error): void;

  /** Writes a log message at the 'info' level. */
  info(message: string, error?: Error): void;

  /** Writes a log message at the 'debug' level. */
  debug(message: string, error?: Error): void;
}

/**
 * The ambient logger. Ported code calls this freely.
 *
 * Tests install a no-op implementation (src/test-setup.ts); the app installs a
 * console-backed one at startup (src/lib/logging/install-logger.ts). The real
 * file/transport-backed logger arrives with Phase 6 of the migration.
 */
declare const log: IDesktopLogger;
