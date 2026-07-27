/**
 * Installs the ambient `log` global that ported desktop-plus code calls.
 *
 * This is a deliberately minimal console-backed stand-in so that ported
 * modules which log don't crash on a missing global. The real implementation —
 * file transports, log rotation, levels wired to a Rust-side `tracing`
 * subscriber — arrives with Phase 6 of the migration, which replaces the old
 * Winston-based desktop-console-transport/desktop-file-transport pair.
 *
 * Must be called before any ported module runs. See src/globals.d.ts for the
 * `IDesktopLogger` shape.
 */
export function installLogger() {
  const format = (message: string, error?: Error) =>
    error ? `${message}\n${error.stack ?? error.message}` : message;

  const logger: IDesktopLogger = {
    error: (message, error) => console.error(format(message, error)),
    warn: (message, error) => console.warn(format(message, error)),
    info: (message, error) => console.info(format(message, error)),
    debug: (message, error) => console.debug(format(message, error)),
  };

  Object.assign(globalThis, { log: logger });
}
