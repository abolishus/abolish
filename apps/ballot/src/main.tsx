// First, before any other module: creates the one Trusted Types policy the CSP
// allows, ballot-worker, so no code imported after it can claim the name. It
// does nothing else, so it is safe on a path gateway too (T-43).
import "./worker-policy.ts";

import { newIdentitySecret } from "@abolishus/crypto";
import { formatMessage, I18nProvider } from "@abolishus/ui";
import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { App, SharedOrigin } from "./app.tsx";
import { backUp, fetchIdentityBackup, putIdentityBackup } from "./backup.ts";
import {
  castAsAsked,
  declinePosting,
  eraseShares,
  readCasts,
  recordBoarded,
  recordCast,
  recordReceipt,
  recordReceiptBoarded,
} from "./casts.ts";
import type { Backer } from "./backup-offer.tsx";
import { confirming, STAGING, tier0Region } from "./deployment.ts";
import {
  createIdentity,
  readBackupCredential,
  readIdentity,
  recordTier0Membership,
  recordTier0Request,
  replaceMovedIdentity,
  restoreIdentity,
  saveBackupCredential,
} from "./identity.ts";
import { deliverShare } from "./intake.ts";
import { LocaleChoice } from "./language-switch.tsx";
import { type Link, parseLink } from "./link.ts";
import { loadBoard, loadChainTime, loadElection, loadGroupRegistry, loadPostings } from "./load.ts";
import {
  keepChosenLocale,
  type Locale,
  pickLocale,
  pollLanguages,
  readChosenLocale,
} from "./locales.ts";
import { catalogs } from "./messages.ts";
import type { ElectionSource } from "./open.tsx";
import { onSharedGatewayPath } from "./origin.ts";
import { postingTopics, postThroughRelay, sendPosting, timedFetch } from "./posting.ts";
import type { Recoverer } from "./recover.tsx";
import { recover } from "./recovery.ts";
import { loadProverArtifacts, ProverArtifactError } from "./prover-artifacts.ts";
import { castBallot } from "./prover-client.ts";
import type { Registrar } from "./register.tsx";
import { submitReceipt } from "./receipts.ts";
import { sendTier0Request } from "./registration.ts";
import { sendBallot } from "./send.ts";
import { BallotWorker, WorkerFailure } from "./worker-client.ts";
// No module imported here may do anything at import time (spawn a worker,
// read storage): it would run before the path-gateway check below.
import "./styles.css";

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
const confirmingDeployment = confirming(STAGING);
// The passkey backup, where this build offers one (`Deployment.backups`).
const backer: Backer | undefined = !STAGING.backups
  ? undefined
  : {
      credential: () => readBackupCredential(),
      backUp: () =>
        backUp({
          credentials: navigator.credentials,
          rpId: STAGING.backupRpId,
          identity: () => readIdentity(),
          credential: () => readBackupCredential(),
          keep: (credential) => saveBackupCredential(credential),
          // In a worker of its own, so a backup never waits behind, or stops,
          // the worker holding the poll. `backupSeal` reaches its postMessage
          // before its first await, so both are copied before this returns.
          async seal(prf, secret) {
            const own = new BallotWorker();
            try {
              return await own.backupSeal(prf, secret);
            } finally {
              own.terminate();
            }
          },
          put: (locator, envelope) =>
            putIdentityBackup(STAGING, locator, envelope, (url, init) => fetch(url, init)),
          fetch: (locator) =>
            fetchIdentityBackup(STAGING, locator, (url, init) => fetch(url, init)),
          now: () => Date.now(),
        }),
      now: () => Date.now(),
    };

// Recovery from the passkey backup, where this build offers one and reads
// the group registry the recovered identity is checked against. Each
// recovery in a worker of its own, terminated once it settles, so a
// recovery that stops before the open leaves no PRF output behind (T-41).
const recoverer: Recoverer | undefined =
  !STAGING.backups || groupRegistry === undefined || pinned === undefined
    ? undefined
    : {
        async recover() {
          const own = new BallotWorker();
          try {
            return await recover({
              credentials: navigator.credentials,
              rpId: STAGING.backupRpId,
              identity: () => readIdentity(),
              locate: (prf) => own.backupLocator(prf),
              fetch: (locator) =>
                fetchIdentityBackup(STAGING, locator, (url, init) => fetch(url, init)),
              registry: () => loadGroupRegistry(STAGING, (url, init) => fetch(url, init)),
              open: (envelope, { block, records }) =>
                own.backupOpen({
                  envelope,
                  block,
                  groups: STAGING.tier0Groups,
                  records,
                  registry: fromHex(groupRegistry.address.slice(2)),
                  chainId: STAGING.chainId,
                  version: groupRegistry.eventVersion,
                  ...pinned,
                }),
              restore: (secret, group) => restoreIdentity(secret, group),
              keep: (credential) => saveBackupCredential(credential),
            });
          } finally {
            own.terminate();
          }
        },
      };

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
        confirmRegistry:
          confirmingDeployment === undefined
            ? undefined
            : () => loadGroupRegistry(confirmingDeployment, (url, init) => fetch(url, init)),
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
        async replace(secret) {
          const replacement = newIdentitySecret();
          try {
            return await replaceMovedIdentity(secret, replacement);
          } finally {
            replacement.fill(0);
          }
        },
        now: () => Date.now(),
        backup: backer,
        recovery: recoverer,
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
  casts: (electionId, tier) => readCasts(electionId, tier),
  record: async (electionId, tier, ballot, shares, asked) =>
    castAsAsked(ballot, asked) ? recordCast(electionId, tier, ballot, shares) : "not-asked",
  intake: (definitionHash) => withWorker((used) => used.intake(definitionHash)),
  deliver: (seat, delivery) =>
    deliverShare(STAGING, seat, delivery, (url, init) => fetch(url, init)),
  receipt: (ballot, receipt) => withWorker((used) => used.receipt(ballot, receipt)),
  posting: (ballot, share) => withWorker((used) => used.posting(ballot, share)),
  // A posting goes through the relay to the board this build pins; with no
  // board there is no contract path, and no posting is offered.
  ...(STAGING.board === undefined
    ? {}
    : {
        post: (
          _electionId: Uint8Array,
          ballot: Uint8Array,
          postings: readonly Uint8Array[],
          cutoff: bigint,
        ) => {
          const { definitionHash, ballotHash } = postingTopics(postings);
          // Each request bounded, so neither the relay nor the RPC can hold
          // the client past its deadlines (T-25, T-50).
          const fetchFn = timedFetch((url, init) => fetch(url, init));
          return postThroughRelay(
            {
              send: (posting) => sendPosting(STAGING, posting, ballot, fetchFn),
              find: (head, from, stop) =>
                loadPostings(
                  STAGING,
                  definitionHash,
                  ballotHash,
                  fetchFn,
                  head,
                  from,
                  undefined,
                  undefined,
                  stop,
                ),
              now: () => Date.now(),
              sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            },
            postings,
            cutoff,
          );
        },
      }),
  declinePosting: (electionId, tier, ballot) => declinePosting(electionId, tier, ballot),
  declineSeal: (ballot) => withWorker((used) => used.decline(ballot)),
  eraseShares: (electionId, tier) => eraseShares(electionId, tier),
  chainTime: () => loadChainTime(STAGING, (url, init) => fetch(url, init)),
  now: () => Date.now(),
  forcedInclusion: STAGING.forcedInclusion,
  keepReceipt: (electionId, tier, ballot, checked) =>
    recordReceipt(electionId, tier, ballot, checked),
  send: (electionId, ballot) =>
    sendBallot(STAGING, electionId, ballot, (url, init) => fetch(url, init)),
  keepBoarded: (electionId, tier, ballot, boarded) =>
    recordBoarded(electionId, tier, ballot, boarded),
  submitReceipt: (electionId, receipt) =>
    submitReceipt(STAGING, electionId, receipt, (url, init) => fetch(url, init)),
  keepReceiptBoarded: (electionId, tier, ballot, checked, boarded) =>
    recordReceiptBoarded(electionId, tier, ballot, checked, boarded),
  registrar,
  // Only the operator's relay so far: the route that bypasses it and the
  // contract path for a posting come first (P2-8 part 3c-1b-2b-2b-2d-2b-2).
  delivers: false,
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

/**
 * The fragment's link, with its pick taken out of the address once read: the
 * tab's history entry then keeps only the election, so nobody who picks up
 * the device later finds there which answer was tapped (T-45). Reloading
 * opens the poll with nothing chosen.
 */
function takeLink(): Link {
  const read = parseLink(location.hash);
  if (read.kind === "election" && read.pick !== undefined)
    history.replaceState(history.state, "", `#election=${read.hex}`);
  return read;
}

// A new fragment (another link opened in this tab) opens its election. The
// link is read once per fragment, here rather than in a render, so the
// election's bytes keep their identity across renders, its check runs once,
// and the pick taken out of the address isn't lost to a second read.
let link = takeLink();
const listeners = new Set<() => void>();
addEventListener("hashchange", () => {
  link = takeLink();
  for (const listener of listeners) listener();
});
const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => void listeners.delete(onChange);
};
// The screen's language (P2-28 part 4b; locales.ts): the voter's choice from
// the frame's switch, kept on this device, else the browser's. On a shared
// gateway path this origin's storage is other sites' too, so a choice is
// neither read from it nor kept there, and the refusal offers no switch (T-43).
const shared = onSharedGatewayPath(location.pathname);
interface Language {
  readonly locale: Locale;
  /** What a poll's own text is picked by (`pollLanguages`). */
  readonly languages: readonly string[];
}
const languageOf = (chosen: Locale | undefined): Language => ({
  locale: pickLocale(chosen, navigator.languages),
  languages: pollLanguages(chosen, navigator.languages),
});
let language = languageOf(shared ? undefined : readChosenLocale(() => localStorage));
const languageListeners = new Set<() => void>();
// The document says what the screen is in: its `lang` for assistive
// technology and the browser's translation offer, its title for the tab.
function showLanguage() {
  document.documentElement.lang = language.locale;
  document.title = formatMessage(language.locale, catalogs[language.locale].name);
}
showLanguage();
function chooseLocale(locale: Locale) {
  keepChosenLocale(() => localStorage, locale);
  language = languageOf(locale);
  showLanguage();
  for (const listener of languageListeners) listener();
}
const subscribeLanguage = (onChange: () => void) => {
  languageListeners.add(onChange);
  return () => void languageListeners.delete(onChange);
};

function Client({ languages }: { languages: readonly string[] }) {
  const current = useSyncExternalStore(subscribe, () => link);
  return <App link={current} source={source} origin={location.origin} languages={languages} />;
}

function Root() {
  const { locale, languages } = useSyncExternalStore(subscribeLanguage, () => language);
  return (
    <I18nProvider locale={locale}>
      {shared ? (
        // Without the query or fragment, which a ballot link may use to carry the poll.
        <SharedOrigin address={location.origin + location.pathname} />
      ) : (
        <LocaleChoice value={chooseLocale}>
          <Client languages={languages} />
        </LocaleChoice>
      )}
    </I18nProvider>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
