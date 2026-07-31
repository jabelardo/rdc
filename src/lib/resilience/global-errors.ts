function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Webviews do not expose Node's `uncaughtException`. Keep browser diagnostics
 * intact and add durable application-log records for failures outside React's
 * render lifecycle.
 */
export function installGlobalErrorLogging(): () => void {
  const onError = (event: ErrorEvent) => {
    log.error('Uncaught renderer error', asError(event.error ?? event.message))
  }
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    log.error('Unhandled renderer promise rejection', asError(event.reason))
  }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onUnhandledRejection)

  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onUnhandledRejection)
  }
}
