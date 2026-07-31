import { debug, error, info, warn } from '@tauri-apps/plugin-log'

/**
 * Installs the ambient `log` global that ported desktop-plus code calls.
 *
 * Phase 4 wires records into Tauri's stdout and application-log targets.
 * Phase 6 still owns retention policy, crash context and replacing the old
 * Winston transport pipeline.
 *
 * Must be called before any ported module runs. See src/globals.d.ts for the
 * `IDesktopLogger` shape.
 */
export function installLogger() {
  const format = (message: string, error?: Error) =>
    error ? `${message}\n${error.stack ?? error.message}` : message
  const forward = (
    sink: (message: string) => Promise<void>,
    message: string,
    cause?: Error
  ) => {
    void sink(format(message, cause)).catch(pluginError => {
      console.error('Failed to write application log record', pluginError)
    })
  }

  const logger: IDesktopLogger = {
    error: (message, cause) => {
      forward(error, message, cause)
    },
    warn: (message, cause) => {
      forward(warn, message, cause)
    },
    info: (message, cause) => {
      forward(info, message, cause)
    },
    debug: (message, cause) => {
      forward(debug, message, cause)
    },
  }

  Object.assign(globalThis, { log: logger })
}
