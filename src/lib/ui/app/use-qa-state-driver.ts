import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * The QA driver event name, emitted by the debug-only Rust module
 * (`src-tauri/src/qa_driver.rs`). Keep in sync with `QA_DRIVE_EVENT` there.
 */
const QaDriveEvent = "qa-drive";

type QaDrivePayload = {
  readonly theme: "light" | "dark" | "system" | null;
  readonly view: "changes" | "history" | null;
  readonly sidebarCollapsed: boolean | null;
  readonly repository: string | null;
};

type DriveHandlers = {
  applyTheme: (theme: "light" | "dark" | "system") => Promise<void>;
  setRepositoryView: (view: "changes" | "history") => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  selectRepositoryByPath: (path: string) => Promise<boolean>;
};

/**
 * Returns the payload field handlers that the QA driver needs.
 */
export async function applyQaState(
  payload: QaDrivePayload,
  handlers: DriveHandlers,
): Promise<void> {
  const { theme, view, sidebarCollapsed, repository } = payload;
  if (theme !== null) {
    await handlers.applyTheme(theme);
  }
  if (view !== null) {
    handlers.setRepositoryView(view);
  }
  if (sidebarCollapsed !== null) {
    handlers.setSidebarCollapsed(sidebarCollapsed);
  }
  if (repository !== null) {
    await handlers.selectRepositoryByPath(repository);
  }
}

/** For `__TAURI_INTERNALS__` in jsdom; present in a real webview. */
function isRunningInTauri(): boolean {
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__?: unknown;
    }
  ).__TAURI_INTERNALS__;
  return internals !== undefined;
}

/**
 * Debug-only hook that listens for `qa-drive` events from the Rust QA driver
 * and applies the requested state.
 *
 * It is inert in tests: it only subscribes when `__DEV__` is true AND the page
 * is running inside a real Tauri webview (runtime `__TAURI_INTERNALS__` check),
 * so jsdom unit tests never register the listener. In release builds `__DEV__`
 * is false, so this is dead code there.
 */
export function useQaStateDriver(handlers: DriveHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!__DEV__ || !isRunningInTauri()) {
      return;
    }

    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    void getCurrentWindow()
      .listen<QaDrivePayload>(QaDriveEvent, ({ payload }) => {
        void applyQaState(payload, handlersRef.current).catch((error) => {
          log.error("QA driver failed to apply state", error);
        });
      })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((error) => {
        log.error("QA driver failed to subscribe", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
