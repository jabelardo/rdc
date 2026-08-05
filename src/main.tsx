import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installLogger } from "./lib/logging/install-logger";
import { FatalErrorBoundary } from "./lib/resilience/error-boundary";
import { installGlobalErrorLogging } from "./lib/resilience/global-errors";

installLogger();
installGlobalErrorLogging();
log.info("Renderer logging initialized");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <FatalErrorBoundary>
      <App />
    </FatalErrorBoundary>
  </React.StrictMode>,
);
