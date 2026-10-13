import { cn, Fingerprint } from "@abolishus/ui";
import { ArrowDown, Check, Circle, CircleSlash, EyeOff, Lock, Send } from "lucide-react";
import type { ReactNode } from "react";

import { CLIENT_RELEASE, LEVY, RECEIPT, TRUSTEES } from "./fixtures.ts";
import {
  ANCHOR_ENTRY,
  ANCHORS,
  CIPHERTEXT,
  fmt,
  LEDGER,
  LEVY_TIERS,
  MiniRow,
  pad2,
  RECEIPT_ANCHOR,
  SHARES,
  shortHex,
  SPOILED_ENTRY,
  spacedHex,
  Stage,
  stepProgress,
  THRESHOLD,
  TierSplit,
} from "./home-parts.tsx";

const tier2 = LEVY_TIERS[0]!;
const receiptTime = LEDGER.find((e) => e.index === RECEIPT.entry)!.time;

export const JOURNEY = [
  {
    title: "Encrypted on the phone",
    body: (
      <>
        A voter in Riverside chooses “Yes, renew the levy” in the ballot client. The phone encrypts
        the choice under the election’s public key before anything is sent. What leaves the device
        is a ciphertext and a proof that it holds exactly one valid choice; the choice itself never
        does.
      </>
    ),
  },
  {
    title: "Challenged, if the voter wants to check",
    body: (
      <>
        Before casting, any ballot can be challenged. The phone reveals how it encrypted the ballot,
        a second device decrypts it and shows the choice, and the challenged ballot is spoiled and
        published. Entry {fmt(SPOILED_ENTRY.index)} on this board is one. The voter then encrypts
        afresh and casts.
      </>
    ),
  },
  {
    title: "Recorded on the public board",
    body: (
      <>
        The cast ballot becomes entry {fmt(RECEIPT.entry)}, recorded at {receiptTime}. The voter’s
        receipt carries the same hash and the same fingerprint as the board’s row, so anyone can
        compare the two by eye, without reading hex.
      </>
    ),
  },
  {
    title: "Anchored to Ethereum, every hour",
    body: (
      <>
        At {ANCHORS[RECEIPT_ANCHOR].at} UTC the board’s head hash, which commits to every entry
        before it, was written to Ethereum. From then on entry {fmt(RECEIPT.entry)} can’t be removed
        or altered without the change showing against the chain. The board records each anchor as an
        entry too: {fmt(ANCHOR_ENTRY.index)} is the 14:00 anchor.
      </>
    ),
  },
  {
    title: `Counted by the trustees, ${THRESHOLD} of ${TRUSTEES.length}`,
    body: (
      <>
        When voting closed at 20:00 UTC, the encrypted ballots were combined into one encrypted
        total per tier without opening any of them. {TRUSTEES.length} independent trustees each hold
        a share of the key; any {THRESHOLD} can decrypt the totals and no {THRESHOLD - 1} can. Four
        published their shares, with proofs, between {SHARES[0]?.at} and {SHARES.at(-1)?.at} UTC.
        Among {fmt(tier2.result.ballots)} document-verified voters, {fmt(tier2.yes)} voted yes and{" "}
        {fmt(tier2.no)} voted no.
      </>
    ),
  },
  {
    title: "Recounted by anyone",
    body: (
      <>
        The verifier rebuilds the count from the Ethereum anchors and the board’s archive on IPFS,
        checks every proof, and arrives at the same totals for each tier. It doesn’t need abolish.us
        to be online, and it reports each tier on its own.
      </>
    ),
  },
] as const;

export function JourneyStep({ index }: { index: number }) {
  const step = JOURNEY[index]!;
  return (
    <div className="grid gap-3">
      <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase tabular-nums">
        Step {pad2(index + 1)}
      </p>
      <h3 className="m-0 font-heading text-2xl leading-tight font-semibold">{step.title}</h3>
      <p className="m-0 text-base text-pretty">{step.body}</p>
    </div>
  );
}

function Phone({ challenged }: { challenged: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="w-36 shrink-0 rounded-[1.75rem] border-2 border-foreground p-2.5 sm:w-48 sm:p-3"
    >
      <span className="mx-auto mb-3 block h-1 w-10 bg-foreground/25" />
      <p className="m-0 font-mono text-[0.625rem] tracking-wide text-muted-foreground uppercase sm:text-xs">
        {LEVY.title}
      </p>
      <ul className="m-0 mt-2 grid list-none gap-1.5 p-0 text-xs">
        {LEVY.options.map((o, i) => (
          <li
            key={o.key}
            className={cn(
              "flex items-start gap-2 border p-1.5 sm:p-2",
              i === 0 ? "border-foreground" : "border-border",
            )}
          >
            <span
              className={cn(
                "mt-0.5 size-3 shrink-0 border border-foreground",
                i === 0 && "bg-foreground",
              )}
            />
            <span className="leading-tight">{o.label}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 grid grid-cols-2 gap-1.5 text-center text-[0.625rem] sm:text-xs">
        <span
          className={cn(
            "border py-1.5",
            challenged ? "border-foreground font-semibold" : "border-border",
          )}
        >
          Challenge
        </span>
        <span
          className={cn(
            "border py-1.5",
            challenged ? "border-border" : "border-foreground bg-foreground text-background",
          )}
        >
          Cast
        </span>
      </div>
    </div>
  );
}

function Fact({ icon, label, children }: { icon: ReactNode; label: string; children?: ReactNode }) {
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 gap-y-1">
      <span aria-hidden="true" className="mt-0.5 text-muted-foreground">
        {icon}
      </span>
      <span className="text-sm leading-snug">{label}</span>
      {children === undefined ? null : <span className="col-start-2 min-w-0">{children}</span>}
    </li>
  );
}

function DeviceScene({ challenged }: { challenged: boolean }) {
  return (
    <div className="flex items-start gap-4 sm:gap-8">
      <Phone challenged={challenged} />
      {challenged ? (
        <ol className="m-0 grid min-w-0 list-none gap-3 p-0">
          <Fact icon={<EyeOff className="size-4" />} label="Randomness revealed for this ballot" />
          <Fact
            icon={<ArrowDown className="size-4" />}
            label="Decrypted on a second device"
            children={
              <span className="inline-block border border-foreground px-2 py-1 text-sm font-semibold">
                Yes, renew the levy
              </span>
            }
          />
          <Fact
            icon={<CircleSlash className="size-4" />}
            label={`Spoiled and published as entry ${fmt(SPOILED_ENTRY.index)}`}
            children={
              <span className="flex items-center gap-2">
                <Fingerprint
                  value={SPOILED_ENTRY.hash}
                  label={`Fingerprint of spoiled entry ${fmt(SPOILED_ENTRY.index)}`}
                  size={28}
                />
                <code className="font-mono text-xs">{shortHex(SPOILED_ENTRY.hash)}</code>
              </span>
            }
          />
          <Fact icon={<Lock className="size-4" />} label="Encrypted afresh, then cast" />
        </ol>
      ) : (
        <div className="grid min-w-0 gap-4">
          <div className="grid gap-2">
            <p className="m-0 font-mono text-xs tracking-wide text-muted-foreground uppercase">
              Leaves the phone
            </p>
            <ul className="m-0 grid list-none gap-2 p-0">
              <Fact
                icon={<Send className="size-4" />}
                label="Ciphertext"
                children={
                  <code className="block font-mono text-xs leading-relaxed break-all">
                    {spacedHex(CIPHERTEXT, 8)} …
                  </code>
                }
              />
              <Fact icon={<Send className="size-4" />} label="Proof of one valid choice" />
            </ul>
          </div>
          <div className="grid gap-2 border-t border-border pt-3">
            <p className="m-0 font-mono text-xs tracking-wide text-muted-foreground uppercase">
              Never leaves
            </p>
            <ul className="m-0 grid list-none gap-2 p-0">
              <Fact icon={<Lock className="size-4" />} label="The choice itself" />
              <Fact icon={<Lock className="size-4" />} label="The encryption randomness" />
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function BoardScene({ shown }: { shown: number }) {
  const rows = LEDGER.slice(0, shown).slice(-6);
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <p className="m-0 font-mono text-xs tracking-wide text-muted-foreground uppercase">
          {LEVY.title} · board, newest last
        </p>
        <ol className="m-0 grid min-h-[13.5rem] list-none content-start border-t border-foreground p-0">
          {rows.map((entry) => (
            <MiniRow key={entry.index} entry={entry} mine={entry.index === RECEIPT.entry} />
          ))}
        </ol>
      </div>
      <div className="flex items-center gap-3 border border-border p-3">
        <Fingerprint
          value={RECEIPT.hash}
          label={`Fingerprint of your receipt ${RECEIPT.hash.slice(0, 8)}`}
          size={40}
        />
        <span aria-hidden="true" className="font-mono text-sm text-muted-foreground">
          =
        </span>
        <Fingerprint
          value={RECEIPT.hash}
          label={`Fingerprint of entry ${fmt(RECEIPT.entry)}`}
          size={40}
        />
        <p className="m-0 min-w-0 text-sm leading-snug">
          Receipt and entry {fmt(RECEIPT.entry)}: the same glyph, from the same hash.
        </p>
      </div>
    </div>
  );
}

function AnchorScene() {
  const anchor = ANCHORS[RECEIPT_ANCHOR];
  return (
    <div className="grid gap-5">
      <div className="relative pt-8">
        <ol className="relative m-0 grid list-none grid-cols-4 border-t border-foreground p-0">
          {ANCHORS.map((a, i) => (
            <li
              key={a.at}
              className={cn(
                "relative grid justify-items-start gap-2 pt-4 ps-2",
                i === RECEIPT_ANCHOR && "border-s-2 border-s-primary",
                i !== RECEIPT_ANCHOR && "border-s border-s-border",
              )}
            >
              <span className="font-mono text-xs tabular-nums">{a.at}</span>
              <Fingerprint
                value={a.head}
                label={`Fingerprint of the ${a.at} board head`}
                size={32}
              />
              <code className="hidden font-mono text-xs text-muted-foreground sm:block">
                {shortHex(a.tx)}
              </code>
            </li>
          ))}
        </ol>
        <p
          className="absolute top-0 m-0 font-mono text-xs whitespace-nowrap text-recorded"
          style={{ insetInlineStart: "calc(25% + 0.5rem)" }}
        >
          ↓ entry {fmt(RECEIPT.entry)}, {receiptTime}
        </p>
      </div>
      <dl className="m-0 grid gap-x-4 gap-y-1 border-t border-border pt-4 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-muted-foreground">First anchor to include it</dt>
        <dd className="m-0 font-mono">{anchor.at} UTC</dd>
        <dt className="text-muted-foreground">Board head</dt>
        <dd className="m-0 font-mono text-xs break-all">{spacedHex(anchor.head, 16)}</dd>
        <dt className="text-muted-foreground">Ethereum transaction</dt>
        <dd className="m-0 font-mono text-xs break-all">{spacedHex(anchor.tx, 16)}</dd>
      </dl>
    </div>
  );
}

function TrusteeScene({ shares }: { shares: number }) {
  const published = SHARES.slice(0, shares);
  const met = shares >= THRESHOLD;
  return (
    <div className="grid gap-5">
      <ol className="m-0 grid list-none grid-cols-7 gap-1.5 p-0">
        {TRUSTEES.map((t, i) => {
          const share = published.find((s) => s.trustee === t);
          const offline = t.status === "Offline";
          return (
            <li
              key={t.key}
              className={cn(
                "grid aspect-square content-between border p-1 transition-colors duration-300 ease-out motion-reduce:transition-none sm:p-1.5",
                share === undefined ? "border-border" : "border-foreground",
                offline && "border-dashed",
              )}
            >
              <span className="font-mono text-xs tabular-nums">{i + 1}</span>
              <span aria-hidden="true" className="justify-self-end">
                {share !== undefined ? (
                  <Check className="size-4 text-recorded" strokeWidth={3} />
                ) : offline ? (
                  <CircleSlash className="size-4 text-muted-foreground" />
                ) : (
                  <Circle className="size-4 text-muted-foreground" />
                )}
              </span>
              <span className="sr-only">
                {t.name}: {share ? `share published at ${share.at} UTC` : t.status.toLowerCase()}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="m-0 font-mono text-xs tracking-wide text-muted-foreground uppercase tabular-nums">
        {shares} of {THRESHOLD} shares needed
        {published.at(-1) === undefined ? "" : ` · latest ${published.at(-1)?.at} UTC`}
      </p>
      {met ? (
        <TierSplit tier={tier2} />
      ) : (
        <p className="m-0 border border-dashed border-border p-3 text-sm text-muted-foreground">
          Totals stay encrypted until {THRESHOLD} trustees have published a share.{" "}
          {THRESHOLD - shares} more needed.
        </p>
      )}
    </div>
  );
}

function RecountScene() {
  const lines = [
    `definition ${shortHex(LEVY.definitionHash)} matches`,
    `${fmt(LEVY.entries)} entries, chain intact to the 20:00 anchor`,
    "every ballot proof valid; spoiled ballots excluded",
    `${THRESHOLD} of ${TRUSTEES.length} decryption shares valid`,
  ];
  return (
    <div className="grid gap-3 border border-foreground p-4 font-mono text-xs leading-relaxed">
      <p className="m-0 break-all text-muted-foreground">
        $ abolish-verify {shortHex(LEVY.id, 8)} --from ethereum,ipfs
      </p>
      <ul className="m-0 grid list-none gap-1 p-0">
        {lines.map((l, i) => (
          <li key={l} className={cn("flex gap-2", (i === 0 || i === 3) && "max-sm:hidden")}>
            <Check
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-recorded"
              strokeWidth={3}
            />
            <span>{l}</span>
          </li>
        ))}
      </ul>
      <table className="w-full border-collapse tabular-nums">
        <caption className="sr-only">Recount by tier</caption>
        <thead>
          <tr className="border-y border-border text-muted-foreground">
            <th scope="col" className="py-1 text-start font-normal">
              Tier
            </th>
            <th scope="col" className="py-1 text-end font-normal">
              Yes
            </th>
            <th scope="col" className="py-1 text-end font-normal">
              No
            </th>
          </tr>
        </thead>
        <tbody>
          {LEVY_TIERS.map((t) => (
            <tr key={t.info.key} className="border-b border-border">
              <th scope="row" className="py-1 text-start font-normal">
                {t.info.short}
                <span className="hidden sm:inline"> · {t.info.name}</span>
              </th>
              <td className="py-1 text-end">{fmt(t.yes)}</td>
              <td className="py-1 text-end">{fmt(t.no)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="m-0">Matches the published result, tier by tier.</p>
      <p className="m-0 text-muted-foreground max-sm:hidden">
        verifier {CLIENT_RELEASE.version} · no abolish.us servers contacted
      </p>
    </div>
  );
}

export function JourneyGraphic({ step, progress }: { step: number; progress: number }) {
  const local = stepProgress(progress, step, JOURNEY.length);
  const title = JOURNEY[step]?.title ?? "";
  let body: ReactNode;
  switch (step) {
    case 0:
    case 1:
      body = <DeviceScene challenged={step === 1} />;
      break;
    case 2:
      body = <BoardScene shown={Math.min(LEDGER.length, 4 + Math.round(local * 8))} />;
      break;
    case 3:
      body = <AnchorScene />;
      break;
    case 4:
      body = <TrusteeScene shares={Math.min(THRESHOLD, 1 + Math.floor(local * 5))} />;
      break;
    default:
      body = <RecountScene />;
  }
  return (
    <Stage testId="journey-graphic" step={step} total={JOURNEY.length} title={title}>
      <div
        key={step}
        className="motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in"
      >
        {body}
      </div>
    </Stage>
  );
}
