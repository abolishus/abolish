import { cn, Fingerprint } from "@abolishus/ui";
import {
  ArrowDown,
  ArrowRight,
  Check,
  Circle,
  CircleSlash,
  KeyRound,
  Lock,
  ShieldCheck,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

import { BOARD_HASHES, CLIENT_RELEASE, LEVY, RECEIPT, TRUSTEES, type TierKey } from "./fixtures.ts";
import {
  CIPHERTEXT,
  fmt,
  LEDGER,
  LEVY_TIERS,
  type LevyTier,
  MiniRow,
  pct,
  SHARES,
  shortHex,
  SPOILED_ENTRY,
  spacedHex,
  Stage,
  stepProgress,
  THRESHOLD,
  TierSplit,
} from "./home-parts.tsx";

export interface ChapterStep {
  title: string;
  body: ReactNode;
}

const label = "m-0 font-mono text-xs tracking-wide text-muted-foreground uppercase";
const settle =
  "transition-colors duration-300 ease-out motion-reduce:transition-none motion-safe:animate-in motion-safe:fade-in";

/** A box in a diagram: ruled, square, its state in words and line style as well as colour. */
function Box({
  active = false,
  muted = false,
  className,
  children,
}: {
  active?: boolean;
  muted?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "min-w-0 border p-3 transition-colors duration-300 ease-out motion-reduce:transition-none",
        active ? "border-foreground border-s-4 border-s-primary" : "border-border",
        muted && "border-dashed",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* 01 · Identity tiers ---------------------------------------------------- */

const tierBy = (key: TierKey) => LEVY_TIERS.find((t) => t.info.key === key)!;
const t2 = tierBy("tier2");
const t1 = tierBy("tier1");
const t0 = tierBy("tier0");

const COST: Record<TierKey, { cells: number; words: string }> = {
  tier0: { cells: 1, words: "Another passkey" },
  tier1: { cells: 2, words: "People to vouch falsely" },
  tier2: { cells: 3, words: "A forged government document" },
};

export const TIER_STEPS: ChapterStep[] = [
  {
    title: "Tier 0: a passkey",
    body: (
      <>
        Anyone can open an account with a passkey, and anyone can open several. On the levy,{" "}
        {fmt(t0.result.ballots)} Tier 0 ballots were cast, from {fmt(t0.result.eligible)} accounts
        eligible when voting closed. Those numbers count accounts, not people.
      </>
    ),
  },
  {
    title: "Tier 1: vouched for",
    body: (
      <>
        A Tier 1 voter has been vouched for by people who are already verified, so a false identity
        needs accomplices who put their own standing behind it. {fmt(t1.result.ballots)} of{" "}
        {fmt(t1.result.eligible)} eligible Tier 1 voters took part.
      </>
    ),
  },
  {
    title: "Tier 2: document-verified",
    body: (
      <>
        A Tier 2 voter has proved, with a zero-knowledge proof on their own phone, that they hold a
        government-signed passport or licence. The proof shows neither the document nor the person;
        only that this document hasn’t voted before. {fmt(t2.result.ballots)} of{" "}
        {fmt(t2.result.eligible)} took part.
      </>
    ),
  },
  {
    title: "Reported side by side, never summed",
    body: (
      <>
        On the levy, document-verified voters chose yes ({pct(t2.yes, t2.result.ballots)} of{" "}
        {fmt(t2.result.ballots)}), as did vouched voters ({pct(t1.yes, t1.result.ballots)} of{" "}
        {fmt(t1.result.ballots)}), while passkey accounts chose no ({pct(t0.no, t0.result.ballots)}{" "}
        of {fmt(t0.result.ballots)}). One blended figure would have reported whoever opened the most
        accounts.
      </>
    ),
  },
];

function TierRow({ tier, active, seen }: { tier: LevyTier; active: boolean; seen: boolean }) {
  const cost = COST[tier.info.key];
  return (
    <Box active={active} muted={!seen}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="m-0 text-sm font-semibold">
          <span className="font-mono text-xs font-normal text-muted-foreground">
            {tier.info.short}
          </span>{" "}
          {tier.info.name}
        </p>
        <p className="m-0 font-mono text-xs tabular-nums">
          {seen ? `${fmt(tier.result.ballots)} of ${fmt(tier.result.eligible)}` : "—"}
        </p>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <span aria-hidden="true" className="flex gap-0.5">
          {[1, 2, 3].map((c) => (
            <span
              key={c}
              className={cn(
                "h-2 w-6 border border-foreground",
                c <= cost.cells && seen ? "bg-foreground" : "bg-transparent",
              )}
            />
          ))}
        </span>
        <p className="m-0 text-xs text-muted-foreground">To fake one: {cost.words.toLowerCase()}</p>
      </div>
    </Box>
  );
}

export function TiersDiagram({ step }: { step: number }) {
  const order = [t2, t1, t0];
  const activeKey: TierKey | undefined = (["tier0", "tier1", "tier2"] as const)[step];
  return (
    <Stage testId="diagram-tiers" step={step} total={TIER_STEPS.length} title="Who is counted">
      {step < 3 ? (
        <div key="ladder" className={cn("grid gap-2", settle)}>
          <p className={label}>Strongest first · ballots of eligible</p>
          {order.map((tier) => {
            const rank = ["tier0", "tier1", "tier2"].indexOf(tier.info.key);
            return (
              <TierRow
                key={tier.info.key}
                tier={tier}
                active={tier.info.key === activeKey}
                seen={rank <= step}
              />
            );
          })}
        </div>
      ) : (
        <div key="results" className={cn("grid gap-4", settle)}>
          <p className={cn(label, "max-sm:hidden")}>{LEVY.title} · three results, three scopes</p>
          {order.map((tier) => (
            <TierSplit key={tier.info.key} tier={tier} className="border-t border-border pt-3" />
          ))}
          <p className="m-0 border-t-2 border-foreground pt-3 text-sm">
            No total row. The tiers disagree, and both answers are reported.
          </p>
        </div>
      )}
    </Stage>
  );
}

/* 02 · Ballot secrecy ----------------------------------------------------- */

export const SECRECY_STEPS: ChapterStep[] = [
  {
    title: "The choice is made on your phone",
    body: (
      <>
        The ballot client runs on your own device. It shows the question and options exactly as the
        poll’s definition commits to them, and your choice is held only in the phone’s memory.
      </>
    ),
  },
  {
    title: "It is encrypted there",
    body: (
      <>
        The phone encrypts the choice under the election’s public key, which the {TRUSTEES.length}{" "}
        trustees made together; no one holds the matching private key whole. Fresh randomness makes
        two identical choices look unrelated.
      </>
    ),
  },
  {
    title: "With a proof that it is valid",
    body: (
      <>
        The phone attaches a zero-knowledge proof that the ciphertext holds exactly one of the
        options, so a ballot can’t carry a hundred votes or a negative one, without revealing which
        option it is.
      </>
    ),
  },
  {
    title: "Only the sealed ballot leaves",
    body: (
      <>
        What crosses the network is the ciphertext and its proof. The plaintext choice and the
        randomness never leave the device, and the randomness is discarded once you cast. Our
        servers could not read your ballot if they wanted to.
      </>
    ),
  },
];

function Chip({
  name,
  value,
  icon,
  active = false,
}: {
  name: string;
  value?: string;
  icon?: ReactNode;
  active?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid gap-1 border p-2 motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in",
        active ? "border-foreground" : "border-border",
      )}
    >
      <p className="m-0 flex items-center gap-1.5 text-xs font-semibold">
        {icon === undefined ? null : (
          <span aria-hidden="true" className="text-muted-foreground">
            {icon}
          </span>
        )}
        {name}
      </p>
      {value === undefined ? null : (
        <code className="font-mono text-xs break-all text-muted-foreground">{value}</code>
      )}
    </div>
  );
}

export function SecrecyDiagram({ step }: { step: number }) {
  const sent = step >= 3;
  return (
    <Stage
      testId="diagram-secrecy"
      step={step}
      total={SECRECY_STEPS.length}
      title="What leaves the phone"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-3">
        <div className="grid content-start gap-2">
          <p className={label}>Your phone</p>
          <Chip
            name="Your choice"
            value="Yes, renew the levy"
            icon={<Lock className="size-3.5" />}
            active={step === 0}
          />
          {step >= 1 ? (
            <Chip
              name="Randomness"
              value={sent ? "discarded after casting" : "7c41 e09a …"}
              icon={<Lock className="size-3.5" />}
              active={step === 1}
            />
          ) : null}
          {step >= 1 && !sent ? (
            <Chip
              name="Ciphertext"
              value={`${spacedHex(CIPHERTEXT, 3)} …`}
              icon={<KeyRound className="size-3.5" />}
              active={step === 1}
            />
          ) : null}
          {step >= 2 && !sent ? (
            <Chip
              name="Validity proof"
              value="one option, no more"
              icon={<ShieldCheck className="size-3.5" />}
              active={step === 2}
            />
          ) : null}
        </div>
        <div aria-hidden="true" className="flex flex-col items-center gap-2 pt-6">
          <span className="w-px flex-1 border-s border-dashed border-foreground" />
          <ArrowRight
            className={cn(
              "size-4 transition-colors duration-300 motion-reduce:transition-none",
              sent ? "text-foreground" : "text-border",
            )}
          />
          <span className="w-px flex-1 border-s border-dashed border-foreground" />
        </div>
        <div className="grid content-start gap-2">
          <p className={label}>Public board</p>
          {sent ? (
            <>
              <Chip
                name="Ciphertext"
                value={`${spacedHex(CIPHERTEXT, 3)} …`}
                icon={<KeyRound className="size-3.5" />}
                active
              />
              <Chip
                name="Validity proof"
                value="checked by anyone"
                icon={<ShieldCheck className="size-3.5" />}
                active
              />
            </>
          ) : (
            <p className="m-0 border border-dashed border-border p-2 text-xs text-muted-foreground">
              Nothing yet. The board only ever receives sealed ballots.
            </p>
          )}
        </div>
      </div>
      <p className="m-0 border-t border-border pt-3 font-mono text-xs text-muted-foreground">
        Election public key · made by {TRUSTEES.length} trustees · {shortHex(LEVY.definitionHash)}
      </p>
    </Stage>
  );
}

/* 03 · Cast as intended --------------------------------------------------- */

const SECOND_CIPHERTEXT = "3e9b52d10c7af4689e2b1d05c3a7f6e81b4d9c2a0e5f7b3d6a8c1e4f2b9d0a7c";

export const CHALLENGE_STEPS: ChapterStep[] = [
  {
    title: "The phone commits first",
    body: (
      <>
        After encrypting, the phone shows the fingerprint of the sealed ballot and only then asks
        whether to cast it or challenge it. Having shown the fingerprint, it can’t change what is
        inside.
      </>
    ),
  },
  {
    title: "Challenge: open it on another device",
    body: (
      <>
        A challenge makes the phone reveal the randomness it used. Any second device running the
        verifier decrypts the ballot and shows the choice it holds. If it shows anything other than
        what you chose, the ballot client is cheating.
      </>
    ),
  },
  {
    title: "The opened ballot is spoiled, in public",
    body: (
      <>
        An opened ballot can’t be cast, because its secrecy is gone. It goes on the board as a
        spoiled ballot, so anyone can recheck it later: entry {fmt(SPOILED_ENTRY.index)} on the levy
        is one.
      </>
    ),
  },
  {
    title: "Then cast a fresh one",
    body: (
      <>
        The phone encrypts your choice again with new randomness, which gives a new fingerprint, and
        you cast that. A cheating client can’t tell in advance which ballots will be challenged, so
        every challenge is a chance to catch it.
      </>
    ),
  },
];

function SealedBallot({
  hash,
  name,
  status,
  active,
}: {
  hash: string;
  name: string;
  status: string;
  active: boolean;
}) {
  return (
    <Box active={active} className="flex items-center gap-3">
      <Fingerprint
        value={hash}
        label={`Fingerprint of ${name.toLowerCase()}, ${hash.slice(0, 8)}`}
        size={44}
      />
      <div className="grid min-w-0 gap-0.5">
        <p className="m-0 text-sm font-semibold">{name}</p>
        <p className="m-0 font-mono text-xs text-muted-foreground">{shortHex(hash)}</p>
        <p className="m-0 text-xs">{status}</p>
      </div>
    </Box>
  );
}

export function ChallengeDiagram({ step }: { step: number }) {
  const challenged = step >= 1;
  return (
    <Stage
      testId="diagram-challenge"
      step={step}
      total={CHALLENGE_STEPS.length}
      title="Cast or challenge"
    >
      <div className="grid gap-3">
        <SealedBallot
          hash={CIPHERTEXT}
          name="Sealed ballot A"
          status={step === 0 ? "Fingerprint shown; waiting for your decision" : "Challenged"}
          active={step <= 2}
        />
        <div aria-hidden="true" className="flex justify-center">
          <ArrowDown className="size-4 text-muted-foreground" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Box active={step === 1 || step === 2} muted={!challenged}>
            <p className="m-0 text-sm font-semibold">Challenge</p>
            {challenged ? (
              <div className="mt-2 grid gap-2">
                <p className="m-0 text-xs text-muted-foreground">Decrypted elsewhere:</p>
                <p className="m-0 border border-foreground px-2 py-1 text-xs font-semibold">
                  Yes, renew the levy
                </p>
                <p className="m-0 flex items-center gap-1 text-xs">
                  <Check aria-hidden="true" className="size-3.5 text-recorded" strokeWidth={3} />
                  Matches your choice
                </p>
              </div>
            ) : (
              <p className="m-0 mt-2 text-xs text-muted-foreground">Open it and check</p>
            )}
          </Box>
          <Box active={step === 3} muted={step < 3}>
            <p className="m-0 text-sm font-semibold">Cast</p>
            <p className="m-0 mt-2 text-xs text-muted-foreground">
              {step < 3 ? "Seal it and send it" : "Ballot B, sealed afresh, is cast"}
            </p>
          </Box>
        </div>
        {step === 2 ? (
          <ol className={cn("m-0 grid list-none border-t border-foreground p-0", settle)}>
            <MiniRow entry={SPOILED_ENTRY} />
          </ol>
        ) : null}
        {step === 3 ? (
          <div className={settle}>
            <SealedBallot
              hash={SECOND_CIPHERTEXT}
              name="Sealed ballot B"
              status="Cast; a new fingerprint"
              active
            />
          </div>
        ) : null}
      </div>
    </Stage>
  );
}

/* 04 · Recorded as cast --------------------------------------------------- */

const WRONG = BOARD_HASHES[2];

export const RECORDED_STEPS: ChapterStep[] = [
  {
    title: "You leave with a receipt",
    body: (
      <>
        When you cast, the client gives you a receipt: the hash of your sealed ballot, its
        fingerprint, the board entry number and the time. It shows nothing about how you voted.
        Yours is entry {fmt(RECEIPT.entry)}, recorded {RECEIPT.recorded}.
      </>
    ),
  },
  {
    title: "The board holds the same entry",
    body: (
      <>
        Every ballot, spoiled ballot and anchor is an entry on the public board, numbered in order
        and chained to the one before, so an entry can’t be removed without breaking every entry
        after it.
      </>
    ),
  },
  {
    title: "Compare the glyphs",
    body: (
      <>
        The fingerprint is drawn from the first 64 bits of the hash, so two people can compare a
        receipt and a board row at a glance, without reading hex. The same hash always draws the
        same glyph.
      </>
    ),
  },
  {
    title: "A mismatch is conclusive",
    body: (
      <>
        A different glyph means a different hash: no further check is needed. Report it with your
        receipt. A matching glyph is strong evidence, and the full hash beside it, which the
        verifier compares byte for byte, settles the rest.
      </>
    ),
  },
];

export function RecordedDiagram({ step }: { step: number }) {
  const boardHash = step === 3 ? WRONG : RECEIPT.hash;
  const match = boardHash === RECEIPT.hash;
  const rows = LEDGER.filter((e) => Math.abs(e.index - RECEIPT.entry) <= 1).map((e) =>
    e.index === RECEIPT.entry ? { ...e, hash: boardHash } : e,
  );
  return (
    <Stage
      testId="diagram-recorded"
      step={step}
      total={RECORDED_STEPS.length}
      title="Receipt and board"
    >
      <div className="grid gap-4">
        <Box active={step === 0}>
          <p className={label}>Your receipt</p>
          <div className="mt-2 flex items-center gap-3">
            <Fingerprint
              value={RECEIPT.hash}
              label={`Fingerprint of receipt ${RECEIPT.hash.slice(0, 8)}`}
              size={48}
            />
            <div className="grid min-w-0 gap-0.5 font-mono text-xs">
              <span className="break-all">{spacedHex(RECEIPT.hash, 4)} …</span>
              <span className="text-muted-foreground">entry {fmt(RECEIPT.entry)}</span>
            </div>
          </div>
        </Box>
        {step >= 1 ? (
          <div className={settle}>
            <p className={label}>Public board</p>
            <ol className="m-0 mt-2 grid list-none border-t border-foreground p-0">
              {rows.map((entry) => (
                <MiniRow key={entry.index} entry={entry} mine={entry.index === RECEIPT.entry} />
              ))}
            </ol>
          </div>
        ) : null}
        {step >= 2 ? (
          <div
            key={match ? "match" : "mismatch"}
            data-testid="comparison"
            className={cn(
              "flex items-center gap-4 border-2 p-3",
              match ? "border-foreground" : "border-foreground border-dashed",
              settle,
            )}
          >
            <Fingerprint value={RECEIPT.hash} label="Fingerprint on your receipt" size={56} />
            <span aria-hidden="true" className="font-heading text-2xl">
              {match ? "=" : "≠"}
            </span>
            <Fingerprint
              value={boardHash}
              label={`Fingerprint of board entry ${fmt(RECEIPT.entry)}`}
              size={56}
            />
            <p className="m-0 min-w-0 text-sm font-semibold">
              {match ? "Same glyph" : "Different glyph: report it"}
            </p>
          </div>
        ) : null}
      </div>
    </Stage>
  );
}

/* 05 · Counted as recorded ------------------------------------------------ */

export const COUNTED_STEPS: ChapterStep[] = [
  {
    title: "Ballots stay sealed",
    body: (
      <>
        After voting closes the board holds {fmt(t2.result.ballots)} sealed Tier 2 ballots,{" "}
        {fmt(t1.result.ballots)} Tier 1 and {fmt(t0.result.ballots)} Tier 0. None of them is ever
        decrypted on its own.
      </>
    ),
  },
  {
    title: "Combined without opening",
    body: (
      <>
        The encryption is additively homomorphic: multiplying ciphertexts together gives an
        encryption of the sum of their votes. Anyone can do the multiplication, and it gives one
        sealed total for each option in each tier.
      </>
    ),
  },
  {
    title: `${THRESHOLD} of ${TRUSTEES.length} trustees decrypt the totals`,
    body: (
      <>
        Each of the {TRUSTEES.length} trustees holds a share of the private key. Any {THRESHOLD}{" "}
        shares decrypt a total; {THRESHOLD - 1} reveal nothing. On the levy four trustees published
        shares between {SHARES[0]?.at} and {SHARES.at(-1)?.at} UTC, while one trustee was offline
        and two weren’t needed.
      </>
    ),
  },
  {
    title: "Totals, each with a proof",
    body: (
      <>
        Every share carries a proof that it was computed correctly with that trustee’s published
        key, so a trustee that lies is caught, not trusted. Tier 2: {fmt(t2.yes)} yes and{" "}
        {fmt(t2.no)} no. Tier 1: {fmt(t1.yes)} and {fmt(t1.no)}. Tier 0: {fmt(t0.yes)} and{" "}
        {fmt(t0.no)}.
      </>
    ),
  },
];

const SEALED = LEDGER.filter((e) => e.kind === "Ballot").slice(0, 8);

export function CountedDiagram({ step, progress }: { step: number; progress: number }) {
  const local = stepProgress(progress, step, COUNTED_STEPS.length);
  const shares =
    step < 2 ? 0 : step > 2 ? THRESHOLD : Math.min(THRESHOLD, 1 + Math.floor(local * 5));
  const published = SHARES.slice(0, shares);
  return (
    <Stage testId="diagram-counted" step={step} total={COUNTED_STEPS.length} title="The count">
      <div className="grid gap-4">
        {step <= 1 ? (
          <div className="grid gap-2">
            <p className={label}>Sealed Tier 2 ballots</p>
            <ul className="m-0 grid list-none grid-cols-8 gap-1 p-0">
              {SEALED.map((e) => (
                <li key={e.index} className="flex justify-center">
                  <Fingerprint
                    value={e.hash}
                    label={`Sealed ballot, entry ${fmt(e.index)}`}
                    size={30}
                  />
                </li>
              ))}
            </ul>
            <p className="m-0 font-mono text-xs text-muted-foreground tabular-nums">
              and {fmt(t2.result.ballots - SEALED.length)} more
            </p>
          </div>
        ) : null}
        {step >= 1 ? (
          <div className={cn("grid gap-2", settle)}>
            {step === 1 ? (
              <div aria-hidden="true" className="flex justify-center">
                <ArrowDown className="size-4 text-muted-foreground" />
              </div>
            ) : null}
            <p className={label}>Sealed totals, one per tier</p>
            <ul className="m-0 grid list-none grid-cols-3 gap-2 p-0">
              {LEVY_TIERS.map((t) => (
                <li key={t.info.key}>
                  <Box className="grid gap-1 p-2" muted={step < 3}>
                    <span className="font-mono text-xs text-muted-foreground">{t.info.short}</span>
                    {step < 3 ? (
                      <span className="flex items-center gap-1 text-xs">
                        <Lock aria-hidden="true" className="size-3.5" /> sealed
                      </span>
                    ) : (
                      <span className="grid text-xs tabular-nums">
                        <span>Yes {fmt(t.yes)}</span>
                        <span>No {fmt(t.no)}</span>
                      </span>
                    )}
                  </Box>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {step >= 2 ? (
          <div className={cn("grid gap-2", settle)}>
            <p className={label} data-testid="share-count">
              {shares} of {THRESHOLD} shares needed
              {published.at(-1) === undefined ? "" : ` · latest ${published.at(-1)?.at} UTC`}
            </p>
            <ol className="m-0 grid list-none grid-cols-7 gap-1 p-0">
              {TRUSTEES.map((t, i) => {
                const share = published.find((s) => s.trustee === t);
                const offline = t.status === "Offline";
                return (
                  <li
                    key={t.key}
                    className={cn(
                      "grid aspect-square content-between border p-1",
                      share ? "border-foreground" : "border-border",
                      offline && "border-dashed",
                    )}
                  >
                    <span className="font-mono text-xs tabular-nums">{i + 1}</span>
                    <span aria-hidden="true" className="justify-self-end">
                      {share ? (
                        <Check className="size-3.5 text-recorded" strokeWidth={3} />
                      ) : offline ? (
                        <CircleSlash className="size-3.5 text-muted-foreground" />
                      ) : (
                        <Circle className="size-3.5 text-muted-foreground" />
                      )}
                    </span>
                    <span className="sr-only">
                      {t.name}:{" "}
                      {share ? `share published at ${share.at} UTC` : t.status.toLowerCase()}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : null}
      </div>
    </Stage>
  );
}

/* 06 · If abolish.us is taken down ---------------------------------------- */

interface Node {
  name: string;
  role: string;
  /** The first step at which this node is unreachable. */
  downFrom?: number;
}

const LAYERS: { name: string; nodes: Node[] }[] = [
  {
    name: "Entry points",
    nodes: [
      { name: "abolish.us", role: "primary domain", downFrom: 1 },
      { name: "abolish.ch", role: "second domain", downFrom: 3 },
      { name: "abolishus.eth", role: "ENS, via IPFS" },
    ],
  },
  {
    name: "Our services",
    nodes: [
      { name: "API", role: "ballot intake", downFrom: 2 },
      { name: "Board server", role: "fast reads", downFrom: 2 },
      { name: "Worker", role: "anchors, pins", downFrom: 2 },
    ],
  },
  {
    name: "Public infrastructure",
    nodes: [
      { name: "Ethereum", role: "contract, anchors" },
      { name: "IPFS", role: "client, archive" },
    ],
  },
  {
    name: "Anyone",
    nodes: [
      { name: "Community nodes", role: "verifier, reader" },
      { name: "Your own copy", role: "the verifier" },
    ],
  },
];

export const SURVIVES_STEPS: ChapterStep[] = [
  {
    title: "Normally, three ways in",
    body: (
      <>
        The ballot client is published to IPFS and reached through abolish.us, abolishus.eth and
        abolish.ch. Every release is built twice, signed, and its hash published (client{" "}
        {CLIENT_RELEASE.version} is {shortHex(CLIENT_RELEASE.hash)}), so any copy can be checked.
      </>
    ),
  },
  {
    title: "abolish.us is taken down",
    body: (
      <>
        .us is administered by the US government, so it is never the only door. If it goes, the same
        signed client loads from IPFS through abolishus.eth or abolish.ch, and the verifier checks
        that the copy served is the published one.
      </>
    ),
  },
  {
    title: "Our servers are unreachable",
    body: (
      <>
        Without our API the client submits a sealed ballot straight to the election’s Ethereum
        contract. It costs the voter a transaction fee, and the ballot is as valid as any other.
      </>
    ),
  },
  {
    title: "Nothing of ours is left",
    body: (
      <>
        The anchors and direct-submitted ballots are on Ethereum, and the board’s archive is pinned
        on IPFS. Any community node, or anyone running the verifier, can rebuild the board and
        recount every result from those two sources alone.
      </>
    ),
  },
];

export function SurvivesDiagram({ step }: { step: number }) {
  return (
    <Stage
      testId="diagram-survives"
      step={step}
      total={SURVIVES_STEPS.length}
      title="What still works"
    >
      <div className="grid gap-3">
        {LAYERS.map((layer) => (
          <div key={layer.name} className="grid gap-1.5">
            <p className={label}>{layer.name}</p>
            <ul className="m-0 grid list-none grid-cols-3 gap-1.5 p-0">
              {layer.nodes.map((node) => {
                const down = node.downFrom !== undefined && step >= node.downFrom;
                return (
                  <li
                    key={node.name}
                    data-down={down ? "" : undefined}
                    className={cn(
                      "grid min-w-0 content-start gap-0.5 border p-1.5 transition-colors sm:p-2 duration-300 ease-out motion-reduce:transition-none",
                      down ? "border-dashed border-border" : "border-foreground",
                    )}
                  >
                    <span
                      className={cn("text-xs font-semibold break-words", down && "line-through")}
                    >
                      {node.name}
                    </span>
                    <span className="flex items-start gap-1 text-xs text-muted-foreground">
                      {down ? (
                        <X aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                      ) : (
                        <Check
                          aria-hidden="true"
                          className="mt-px size-3.5 shrink-0 text-recorded"
                          strokeWidth={3}
                        />
                      )}
                      {down ? "unreachable" : node.role}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </Stage>
  );
}
