// First, before any other module: creates the one Trusted Types policy the CSP
// allows, ballot-worker, so no code imported after it can claim the name. It
// does nothing else, so it is safe on a path gateway too (T-43).
import "./worker-policy.ts";

import { newIdentitySecret } from "@abolishus/crypto";
import { I18nProvider } from "@abolishus/ui";
import { StrictMode, useMemo, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { App, SharedOrigin } from "./app.tsx";
import { STAGING, tier0Region } from "./deployment.ts";
import {
  createIdentity,
  readIdentity,
  recordTier0Membership,
  recordTier0Request,
} from "./identity.ts";
import { parseLink } from "./link.ts";
import { loadBoard, loadElection, loadGroupRegistry } from "./load.ts";
import type { ElectionSource } from "./open.tsx";
import { onSharedGatewayPath } from "./origin.ts";
import { loadProverArtifacts, ProverArtifactError } from "./prover-artifacts.ts";
import { castBallot } from "./prover-client.ts";
import type { Registrar } from "./register.tsx";
import { sendTier0Request } from "./registration.ts";
import { BallotWorker, WorkerFailure } from "./worker-client.ts";
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

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

// The challenge page's frame comes with the challenge origin, a `ci:` change
// to the client's policy (P2-8 part 3b-2c-2b-2b-2c); until then, and while
// the deployment publishes no single Tier 0 region and pins no group
// registry to read the outcome from, no build registers anyone.
const challengeFrame: Registrar["Challenge"] | undefined = undefined;
const region = tier0Region(STAGING);
const groupRegistry = STAGING.groupRegistry;
const pinned = STAGING.registrars;
const registrar: Registrar | undefined =
  challengeFrame === undefined ||
  region === undefined ||
  groupRegistry === undefined ||
  pinned === undefined
    ? undefined
    : {
        region,
        Challenge: challengeFrame,
        async create() {
          const secret = newIdentitySecret();
          try {
            return await createIdentity(secret);
          } finally {
            secret.fill(0);
          }
        },
        identity: () => readIdentity(),
        // The worker that checked the poll; `withWorker` reaches its
        // postMessage before its first await, so the secret is copied before
        // this returns.
        commitment: (secret) => withWorker((used) => used.commitment(secret)),
        send: (body) => sendTier0Request(STAGING, body, (url, init) => fetch(url, init)),
        record: (secret, request) => recordTier0Request(secret, request),
        registry: () => loadGroupRegistry(STAGING, (url, init) => fetch(url, init)),
        // As `commitment`: the secret is copied before this returns.
        outcome: (secret, asked, { block, records }) =>
          withWorker((used) =>
            used.tier0Outcome({
              secret,
              region: asked,
              block,
              groups: STAGING.tier0Groups,
              records,
              registry: fromHex(groupRegistry.address.slice(2)),
              chainId: STAGING.chainId,
              version: groupRegistry.eventVersion,
              ...pinned,
            }),
          ),
        join: (secret, group) => recordTier0Membership(secret, group),
        now: () => Date.now(),
      };

const source: ElectionSource = {
  load: (electionId, signal) =>
    loadElection(STAGING, electionId, (url, init) => fetch(url, { ...init, signal })),
  async check(electionId, registeredHash, definition, displayText, entries) {
    const used = (worker ??= new BallotWorker());
    try {
      return await used.checkElection(
        electionId,
        registeredHash,
        definition,
        displayText,
        entries,
        STAGING.panels,
      );
    } catch (error) {
      used.terminate();
      if (worker === used) worker = undefined;
      throw error;
    }
  },
  // A seal, its opening, the voter's cell and the cast come from the worker
  // that checked the poll, which holds it; a stopped one fails them, and the
  // screens check the poll anew.
  seal: (definitionHash, cell, votes) =>
    withWorker((used) => used.seal(definitionHash, cell, votes)),
  challenge: (seal) => withWorker((used) => used.challenge(seal)),
  identity: () => readIdentity(),
  loadBoard: (electionId) => loadBoard(STAGING, electionId, (url, init) => fetch(url, init)),
  findCell(definitionHash, secret, { tier, group }, entries) {
    const pinned = STAGING.registrars;
    if (pinned === undefined) return Promise.resolve({ ok: false, problem: "no-registrars" });
    return withWorker((used) =>
      used.findCell({ definitionHash, secret, tier, group, entries, ...pinned }),
    );
  },
  // No L1 source is in the client's connect-src yet: reading L1 from several
  // independent providers, never our API, is part 3c ([[revoting]], Client rule 1).
  l1Block: () => Promise.resolve(undefined),
  async loadArtifacts() {
    try {
      return await loadProverArtifacts({
        base: import.meta.url,
        fetch: (url, init) => fetch(url, init),
        caches: globalThis.caches,
      });
    } catch (error) {
      if (error instanceof ProverArtifactError) return { ok: false, problem: error.problem };
      throw error;
    }
  },
  // `withWorker` and `castBallot` reach the worker's postMessage before
  // their first await, so the secret is copied before this returns.
  cast: (seal, secret, l1, artifacts, onProgress) =>
    withWorker((used) =>
      castBallot(
        used,
        { seal, secret, l1Number: l1.number, l1Hash: l1.hash },
        artifacts,
        onProgress,
      ),
    ),
  registrar,
};

async function withWorker<T>(ask: (used: BallotWorker) => Promise<T>): Promise<T> {
  const used = worker;
  if (used === undefined) throw new WorkerFailure("no ballot worker");
  try {
    return await ask(used);
  } catch (error) {
    used.terminate();
    if (worker === used) worker = undefined;
    throw error;
  }
}

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
