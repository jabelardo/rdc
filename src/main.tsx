import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installLogger } from "./lib/logging/install-logger";

installLogger();
log.info("Renderer logging initialized");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
