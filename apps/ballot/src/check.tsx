import { cn, Fingerprint, groupHex, Hash, useTranslate } from "@abolishus/ui";
import { Check, ChevronDown, ShieldCheck, X } from "lucide-react";
import type { ReactNode } from "react";

import type { ElectionRefusal } from "./election.ts";
import { EverydayFrame, Note, Part, ScreenTitle } from "./frame.tsx";
import { catalogs, type Messages } from "./messages.ts";

// What the voter sees of the checks the client ran before showing a poll
// (P2-20 part 2): one plain line on arrival with the evidence a tap away, or,
// when a check failed, a refusal that names the check in words and shows the
// evidence. The checks themselves are @abolishus/crypto's, run in the worker
// (election.ts); nothing here decides whether an election passed (T-34, T-41).

type Key = keyof Messages;

/** A hash's first two groups of four hex digits, as a label reads it aloud. */
function shortHex(hash: string): string {
  return groupHex(hash).slice(0, 2).join(" ");
}

/**
 * The everyday register's arrival line: "This is the real poll, checked", and
 * one tap away the poll's seal and its registered fingerprint in full, so a
 * voter can compare them with the poll's page. Shown only for an election
 * that passed the worker's check; `definitionHash` is that election's, in
 * lowercase hex.
 */
export function ArrivalCheck({ definitionHash }: { definitionHash: string }) {
  const t = useTranslate(catalogs);
  // A native disclosure: it works without script and sets no inline style,
  // which the client's CSP would block (T-43).
  return (
    <details className="group border border-border">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-3 outline-none focus-visible:ring-3 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ShieldCheck aria-hidden="true" className="size-5 shrink-0 text-recorded" />
        <span className="flex-1 font-medium">{t("realPoll")}</span>
        <ChevronDown aria-hidden="true" className="size-5 shrink-0 group-open:rotate-180" />
      </summary>
      <div className="grid gap-4 border-t border-border px-4 py-4">
        <div className="flex items-start gap-3">
          <Fingerprint
            value={definitionHash}
            label={t("sealLabel", { hash: shortHex(definitionHash) })}
            size={56}
          />
          <p className="m-0 text-pretty">{t("realPollExplained")}</p>
        </div>
        <Hash value={definitionHash} label={t("registeredFingerprint")} />
      </div>
    </details>
  );
}

/**
 * The civic record's account of the same checks, as a list: the client runs
 * from an address of its own, and the election is the one registered, with
 * its hash. `origin` is the page's own origin. Render it only on the path
 * where `onSharedGatewayPath` passed (main.tsx): it states that check passed.
 */
export function ArrivalChecklist({
  definitionHash,
  origin,
}: {
  definitionHash: string;
  origin: string;
}) {
  const t = useTranslate(catalogs);
  return (
    <Part title={t("checksTitle")}>
      <Checklist>
        <OwnOriginItem origin={origin} />
        <CheckItem passed title={t("registeredCheck")}>
          <p className="m-0 text-sm text-muted-foreground">{t("registeredCheckDetail")}</p>
          <Evidence
            hash={definitionHash}
            label={t("registeredHash")}
            fingerprintLabel={t("registeredFingerprintOf", { hash: shortHex(definitionHash) })}
          />
        </CheckItem>
      </Checklist>
    </Part>
  );
}

/**
 * Shown instead of a ballot when the worker's election check refused the
 * election: the failed check in words and, where the definition isn't the
 * registered one, the two fingerprints side by side, so a voter sees the
 * difference without reading hex (T-34). No way forward but another address.
 * The poll's name and class come from the refused definition, so neither is
 * shown: the frame stays in the everyday register with no poll.
 *
 * `registeredHash` is the definition hash the registry holds for the election
 * (lowercase hex), `origin` the page's own origin. Like `ArrivalChecklist`,
 * render it only where the origin check passed: it states that it did.
 */
export function ElectionRefused({
  refusal,
  registeredHash,
  origin,
}: {
  refusal: ElectionRefusal;
  registeredHash: string;
  origin: string;
}) {
  const t = useTranslate(catalogs);
  const { title, detail } = failedCheck(refusal);
  // The rule's name as the spec gives it, for whoever the voter reports this
  // to; the commitment's failure is already named in words.
  const rule =
    refusal.problem === "definition-ill-formed" ||
    (refusal.problem === "display-text-ill-formed" && refusal.rule !== "commitment")
      ? refusal.rule
      : refusal.problem === "ceremony-failed"
        ? refusal.code
        : undefined;
  return (
    <EverydayFrame>
      <ScreenTitle title={t("refusedTitle")}>
        <p className="m-0">{t("refused")}</p>
      </ScreenTitle>
      <Part title={t("checksTitle")}>
        <Checklist>
          <OwnOriginItem origin={origin} />
          <CheckItem passed={false} title={t(title)}>
            <p className="m-0 text-sm">{t(detail)}</p>
            {rule === undefined ? null : (
              <p className="m-0 text-sm text-muted-foreground">
                {t("ruleBroken")}{" "}
                <code translate="no" className="font-mono">
                  {rule}
                </code>
              </p>
            )}
            <Evidence
              hash={registeredHash}
              label={t("registeredHash")}
              fingerprintLabel={t("registeredFingerprintOf", { hash: shortHex(registeredHash) })}
            />
            {refusal.problem === "unregistered-definition" ? (
              <Evidence
                hash={refusal.servedHash}
                label={t("servedHash")}
                fingerprintLabel={t("servedFingerprintOf", { hash: shortHex(refusal.servedHash) })}
              />
            ) : null}
          </CheckItem>
        </Checklist>
      </Part>
      <Part title={t("whatToDoTitle")}>
        <Note tone="warn" title={t("whatToDoNoteTitle")}>
          <p className="m-0">{t("whatToDo")}</p>
        </Note>
      </Part>
    </EverydayFrame>
  );
}

// Each refusal in words. Named one by one, so a problem a later version of
// @abolishus/crypto adds is a type error here rather than shown as another.
function failedCheck(refusal: ElectionRefusal): { title: Key; detail: Key } {
  switch (refusal.problem) {
    case "definition-undecodable":
      return { title: "definitionUndecodable", detail: "definitionUndecodableDetail" };
    case "another-election":
      return { title: "anotherElection", detail: "anotherElectionDetail" };
    case "unregistered-definition":
      return { title: "unregisteredDefinition", detail: "unregisteredDefinitionDetail" };
    case "definition-ill-formed":
      return { title: "definitionIllFormed", detail: "definitionIllFormedDetail" };
    case "display-text-undecodable":
      return { title: "displayTextUndecodable", detail: "displayTextUndecodableDetail" };
    case "display-text-ill-formed":
      // The commitment is the check that catches relabelled options (T-41).
      return refusal.rule === "commitment"
        ? { title: "displayTextChanged", detail: "displayTextChangedDetail" }
        : { title: "displayTextIllFormed", detail: "displayTextIllFormedDetail" };
    case "ceremony-failed":
      // A panel this build doesn't pin isn't a fault of the ceremony; whose
      // keys they are is what this device can't tell (T-37).
      // A missing transcript may be one not boarded yet, which the verifier
      // calls the copy's problem rather than the election's (T-53).
      return refusal.code === "panel-unpinned"
        ? { title: "panelUnpinned", detail: "panelUnpinnedDetail" }
        : refusal.code === "ceremony-transcript-missing"
          ? { title: "ceremonyMissing", detail: "ceremonyMissingDetail" }
          : { title: "ceremonyFailed", detail: "ceremonyFailedDetail" };
  }
}

function Checklist({ children }: { children: ReactNode }) {
  const t = useTranslate(catalogs);
  return (
    <ul
      aria-label={t("checksLabel")}
      className="m-0 grid list-none gap-0 border-y border-foreground p-0"
    >
      {children}
    </ul>
  );
}

function OwnOriginItem({ origin }: { origin: string }) {
  const t = useTranslate(catalogs);
  return (
    <CheckItem passed title={t("ownOriginCheck")}>
      {/* An address can be one long label, so it may break anywhere. */}
      <p className="m-0 text-sm break-all text-muted-foreground">
        {t("ownOriginCheckDetail", { origin })}
      </p>
    </CheckItem>
  );
}

/** One check; whether it passed is in its icon and always in words. */
function CheckItem({
  passed,
  title,
  children,
}: {
  passed: boolean;
  title: string;
  children: ReactNode;
}) {
  const t = useTranslate(catalogs);
  const Icon = passed ? Check : X;
  return (
    <li className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-3 border-b border-border py-4 last:border-b-0">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-6 items-center justify-center border",
          passed ? "border-recorded text-recorded" : "border-destructive text-destructive",
        )}
      >
        <Icon className="size-4" strokeWidth={passed ? 3 : 2} />
      </span>
      <div className="grid gap-1">
        <p className="m-0 font-medium">{title}</p>
        <p
          className={cn(
            "m-0 font-mono text-xs tracking-widest uppercase",
            passed ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {passed ? t("passed") : t("failed")}
        </p>
      </div>
      <div className="col-start-2 grid min-w-0 gap-3">{children}</div>
    </li>
  );
}

/** A hash with its fingerprint beside it. */
function Evidence({
  hash,
  label,
  fingerprintLabel,
}: {
  hash: string;
  label: string;
  fingerprintLabel: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <Fingerprint value={hash} label={fingerprintLabel} size={48} />
      <div className="min-w-0 flex-1 [&_code]:text-sm">
        <Hash value={hash} label={label} />
      </div>
    </div>
  );
}
