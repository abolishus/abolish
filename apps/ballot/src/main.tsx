import { I18nProvider } from "@abolishus/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";
import "./styles.css";

// Matches <html lang> in index.html; the locale picker comes with the ballot screens.
const locale = "en-US";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <I18nProvider locale={locale}>
      <App />
    </I18nProvider>
  </StrictMode>,
);
