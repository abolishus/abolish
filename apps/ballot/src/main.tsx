// First, before any other module: creates the one Trusted Types policy the CSP
// allows, ballot-worker, so no code imported after it can claim the name. It
// does nothing else, so it is safe on a path gateway too (T-43).
import "./worker-policy.ts";

import { I18nProvider } from "@abolishus/ui";
import { StrictMode, useMemo, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { App, SharedOrigin } from "./app.tsx";
import { STAGING } from "./deployment.ts";
import { parseLink } from "./link.ts";
import { loadElection } from "./load.ts";
import type { ElectionSource } from "./open.tsx";
import { onSharedGatewayPath } from "./origin.ts";
import { BallotWorker } from "./worker-client.ts";
// No module imported here may do anything at import time (spawn a worker,
// read storage): it would run before the path-gateway check below.
import "./styles.css";

// Matches <html lang> in index.html; the locale picker comes with the ballot screens.
const locale = "en-US";

// The worker is spawned only once a link names an election, and a stopped
// one (crashed, timed out) is replaced on the next check, so "Try again" can
// recover. A check that fails stops only the worker it ran on, never a newer
// one a later check spawned.
let worker: BallotWorker | undefined;
const source: ElectionSource = {
  load: (electionId, signal) =>
    loadElection(STAGING, electionId, (url, init) => fetch(url, { ...init, signal })),
  async check(electionId, registeredHash, definition, displayText) {
    const used = (worker ??= new BallotWorker());
    try {
      return await used.checkElection(electionId, registeredHash, definition, displayText);
    } catch (error) {
      used.terminate();
      if (worker === used) worker = undefined;
      throw error;
    }
  },
};

// A new fragment (another link opened in this tab) opens its election.
const subscribe = (onChange: () => void) => {
  addEventListener("hashchange", onChange);
  return () => removeEventListener("hashchange", onChange);
};
function Client() {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  // Parsed once per fragment, so the election's bytes keep their identity
  // across renders and its check runs once.
  const link = useMemo(() => parseLink(hash), [hash]);
  return (
    <App link={link} source={source} origin={location.origin} languages={navigator.languages} />
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <I18nProvider locale={locale}>
      {onSharedGatewayPath(location.pathname) ? (
        // Without the query or fragment, which a ballot link may use to carry the poll.
        <SharedOrigin address={location.origin + location.pathname} />
      ) : (
        <Client />
      )}
    </I18nProvider>
  </StrictMode>,
);
