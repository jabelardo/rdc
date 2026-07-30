import { Component, type ErrorInfo, type ReactNode } from 'react'
import { showApplicationLogs } from './logs'

type FatalErrorBoundaryProps = {
  readonly children: ReactNode
  readonly reload?: () => void
}

type FatalErrorBoundaryState = {
  readonly error: Error | null
}

/**
 * Keeps a renderer failure inside the existing trusted window.
 *
 * Electron needed a second process and five IPC channels to render its crash
 * window. A React boundary can retain the native menu, log transport and
 * recovery actions without creating another privileged document.
 */
export class FatalErrorBoundary extends Component<
  FatalErrorBoundaryProps,
  FatalErrorBoundaryState
> {
  public state: FatalErrorBoundaryState = { error: null }

  public static getDerivedStateFromError(error: Error) {
    return { error }
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    const diagnostic = new Error(
      `${error.stack ?? `${error.name}: ${error.message}`}\n\nReact component stack:${info.componentStack ?? ' unavailable'}`
    )
    log.error('The application interface failed to render', diagnostic)
  }

  private showLogs = (): void => {
    void showApplicationLogs().catch(cause => {
      log.error(
        'Unable to reveal the application logs',
        cause instanceof Error ? cause : new Error(String(cause))
      )
    })
  }

  private reload = (): void => {
    if (this.props.reload !== undefined) {
      this.props.reload()
    } else {
      window.location.reload()
    }
  }

  public render(): ReactNode {
    const { error } = this.state
    if (error === null) {
      return this.props.children
    }

    return (
      <main className="fatal-error" role="alert">
        <h1>rdc encountered an error</h1>
        <p>
          The application interface could not continue. The details were
          written to the application log.
        </p>
        <pre>{error.message}</pre>
        <div className="fatal-error-actions">
          <button type="button" onClick={this.showLogs}>
            Show logs
          </button>
          <button type="button" onClick={this.reload}>
            Reload rdc
          </button>
        </div>
      </main>
    )
  }
}
