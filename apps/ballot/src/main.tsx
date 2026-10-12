// First, before any other module: creates the one Trusted Types policy the CSP
// allows, ballot-worker, so no code imported after it can claim the name. It
// does nothing else, so it is safe on a path gateway too (T-43).
import "./worker-policy.ts";

import { I18nProvider } from "@abolishus/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App, SharedOrigin } from "./app.tsx";
import { onSharedGatewayPath } from "./origin.ts";
// No module imported here may do anything at import time (spawn a worker,
// read storage): it would run before the path-gateway check below.
import "./styles.css";

// Matches <html lang> in index.html; the locale picker comes with the ballot screens.
const locale = "en-US";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <I18nProvider locale={locale}>
      {onSharedGatewayPath(location.pathname) ? <SharedOrigin /> : <App />}
    </I18nProvider>
  </StrictMode>,
);
