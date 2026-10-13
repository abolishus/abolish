import {
  BoardZoom,
  type BoardMapLabels,
  type InclusionAnchor,
  type InclusionPathLabels,
  InclusionPath,
  ReceiptStub,
} from "@abolishus/ui";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

import { short } from "./board-data.ts";
import { Micro, Section } from "./board-parts.tsx";
import {
  countKinds,
  entryHash,
  entryTime,
  fmt,
  LEVY_BOARD,
  LEVY_CHECKPOINT,
  LEVY_MINE,
  LEVY_MINE_AT,
  LEVY_PROOF,
  ledgerAround,
} from "./board-place-data.ts";
import { LEVY, RECEIPT } from "./fixtures.ts";
import { MockShell } from "./shell.tsx";

const TOTAL = LEVY_BOARD.kinds.length;
const SEGMENTS = LEVY_BOARD.segments.length;
const SEG = LEVY_MINE_AT.segment;
const SEG_END = SEG.first + SEG.size - 1;
const SEG_COUNTS = countKinds(LEVY_BOARD, SEG.first, SEG.first + SEG.size);
const SPAN = 36;
const MINE_HASH = entryHash(LEVY_BOARD, LEVY_MINE);
const MINE_TIME = entryTime(LEVY_BOARD, LEVY_MINE);
const STEPS = LEVY_PROOF.siblings.length;

/** The map's words, shared by the board page's hero. */
export const MAP_LABELS: BoardMapLabels = {
  caption: `${LEVY.title}: the whole board, ${fmt(TOTAL)} entries in ${SEGMENTS} hourly segments`,
  description: `Every entry on the board as one square, in order: each hour's segment is a block, read down each column and then to the right, so a block's width is its number of entries.`,
  kinds: {
    ballot: "Ballots",
    spoiled: "Spoiled-ballot openings",
    trustee: "Trustee records",
    event: "Contract events",
  },
  anchored: "Segment anchored to Ethereum",
  unanchored: "Not anchored yet",
  mine: "Your entry, {index}",
  position:
    "Your entry is entry {index} of {total}, in the {segment} segment, anchored at {anchor} in Ethereum block {block}.",
  positionPending:
    "Your entry is entry {index} of {total}, in the {segment} segment, not anchored yet.",
  table: {
    summary: "Every segment as a table",
    caption: "Entries per segment, 3 November 2026 (UTC)",
    segment: "Segment",
    entries: "Entries",
    anchor: "Anchored",
    notAnchored: "Not yet",
    breakdown: "{kind}: {count}",
    anchorCell: "{at}, block {block}",
  },
};

export const ANCHOR: InclusionAnchor = {
  root: LEVY_PROOF.root,
  size: LEVY_CHECKPOINT,
  title: "Checkpoint anchored 3 Nov 2026, 15:00 UTC",
  facts: [
    { label: "Segment", value: `${fmt(SEG.segment)} (14:00–15:00 UTC)` },
    { label: "Size", value: `${fmt(LEVY_CHECKPOINT)} entries` },
    { label: "Ethereum block", value: fmt(SEG.anchor!.block) },
    { label: "Transaction", value: `0x${RECEIPT.anchorTx}`, evidence: true },
  ],
};

export const PATH_LABELS: InclusionPathLabels = {
  caption: `Entry ${fmt(LEVY_MINE)} in the tree of ${fmt(LEVY_CHECKPOINT)} entries`,
  leaf: "Your entry",
  entryHash: "Entry hash",
  leafHash: "Leaf hash",
  step: "Step {step} of {total}",
  given: "From the proof",
  computed: "Computed",
  range: "entries {from}–{to}",
  single: "entry {index}",
  count: { one: "{count} entry", other: "{count} entries" },
  root: "Root of all {size} entries",
  anchoredRoot: "Anchored root",
  verdict: {
    verified: `The computed root is the anchored root, all 64 characters. Entry ${fmt(LEVY_MINE)} is on the anchored board.`,
    mismatch:
      "The computed root does not match the anchored root. This path does not show that the entry is on the anchored board.",
    pending: "The computed root is the one your receipt holds. Its checkpoint isn't anchored yet.",
  },
  fingerprint: "Fingerprint of {what}, {hash}",
  levels: {
    one: "{count} step, from your entry to all {size} entries",
    other: "{count} steps, from your entry to all {size} entries",
  },
  full: "Every hash of the proof, in full",
  sides: { left: "on the left", right: "on the right" },
};

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="grid gap-3">
      <Micro>Step {String(n).padStart(2, "0")}</Micro>
      <h3 className="m-0 font-heading text-2xl leading-tight font-semibold">{title}</h3>
      <p className="m-0 text-base text-pretty">{children}</p>
    </div>
  );
}

export interface BoardPlacePageProps {
  /** A copy of the board whose root isn't the anchored one: the proof then fails, in words. */
  mismatch?: boolean;
}

/**
 * The Found state of "Find your receipt", one section further: where the
 * entry sits on the whole board, zooming from every entry to the reader's,
 * then the inclusion proof in full, against the checkpoint on Ethereum.
 */
export function BoardPlacePage({ mismatch = false }: BoardPlacePageProps) {
  const anchor: InclusionAnchor = mismatch
    ? { ...ANCHOR, root: "9c1d6f0e2b7a4c58e3d1a09b6f72c4e8d5a3b1f0c7e9a2d4b6f8e0c1a3d5b7f9" }
    : ANCHOR;
  const verdict = mismatch ? "mismatch" : "verified";
  return (
    <MockShell current="/verify">
      <section aria-labelledby="found-title" className="border-b border-border">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 md:grid-cols-12 md:gap-x-6 md:py-16">
          <div className="grid content-start gap-4 md:col-span-7">
            <Micro>02 · Found</Micro>
            <h1
              id="found-title"
              className="m-0 font-heading text-4xl leading-tight font-semibold tracking-tight text-balance sm:text-5xl"
            >
              Your ballot is on the board
            </h1>
            <p className="m-0 max-w-prose text-lg text-pretty">
              Entry {fmt(LEVY_MINE)} on the board for {LEVY.title} matches your receipt, all 64
              characters. It shows that your encrypted ballot was recorded. It does not show how you
              voted.
            </p>
          </div>
          <div className="md:col-span-5">
            <ReceiptStub
              title="Your receipt"
              hash={MINE_HASH}
              entry={LEVY_MINE}
              recordedAt={new Date(`2026-11-03T${MINE_TIME}Z`)}
              labels={{
                hash: "Receipt hash",
                fingerprint: `Fingerprint of receipt ${MINE_HASH.slice(0, 4)} ${MINE_HASH.slice(4, 8)}`,
                entry: "Board entry",
                recordedAt: "Recorded",
              }}
            />
          </div>
        </div>
      </section>

      <Section
        index="05"
        mark="Your place"
        title="Your place on the board"
        lede={`From ${fmt(TOTAL)} entries to yours, and how anyone can check it. Every square below is a real entry, in order; nothing is drawn that isn't on the board.`}
      >
        <BoardZoom
          label={`From ${fmt(TOTAL)} entries to yours`}
          steps={[
            <Step key="board" n={1} title={`${fmt(TOTAL)} entries`}>
              The board for {LEVY.title} holds {fmt(TOTAL)} entries, appended one at a time on 3
              November 2026 and never changed. They fall into {SEGMENTS} hourly segments, and each
              segment was anchored to Ethereum when its hour ended. The busiest, 13:00 to 14:00,
              took {fmt(15_538)}.
            </Step>,
            <Step key="segment" n={2} title="Your hour">
              Entry {fmt(LEVY_MINE)} is in the 14:00 segment: {fmt(SEG.size)} entries,{" "}
              {fmt(SEG.first)} to {fmt(SEG_END)}, of which {fmt(SEG_COUNTS[0]!)} are ballots and{" "}
              {fmt(SEG_COUNTS[3]!)} are ballots submitted directly to the contract. Its checkpoint
              was anchored at 15:00 UTC in Ethereum block {fmt(SEG.anchor!.block)}.
            </Step>,
            <Step key="neighbourhood" n={3} title="Your neighbours">
              The {fmt(SPAN * 2)} entries either side of yours, {fmt(LEVY_MINE - SPAN)} to{" "}
              {fmt(LEVY_MINE + SPAN)}, are other people&rsquo;s encrypted ballots. The board shows
              when each arrived, never who sent it or how they voted.
            </Step>,
            <Step key="entry" n={4} title={`Entry ${fmt(LEVY_MINE)}`}>
              A ballot, recorded at {MINE_TIME} UTC. Its hash, {short(MINE_HASH)}, is the one on
              your receipt, and so is its fingerprint.
            </Step>,
            <Step key="proof" n={5} title="How anyone can check it">
              {STEPS} hashes from the proof take your entry&rsquo;s hash, step by step, to the root
              of the first {fmt(LEVY_CHECKPOINT)} entries: the board as the 15:00 checkpoint covers
              it. That root is the one anchored in block {fmt(SEG.anchor!.block)}, so the entry
              can&rsquo;t be removed or changed without the change showing against Ethereum.
            </Step>,
          ]}
          board={{ kinds: LEVY_BOARD.kinds, segments: LEVY_BOARD.segments, mine: LEVY_MINE }}
          views={{
            board: MAP_LABELS,
            segment: {
              ...MAP_LABELS,
              caption: `The 14:00 segment: ${fmt(SEG.size)} entries, anchored at 15:00 UTC`,
              description:
                "Every entry of the 14:00 segment as one square, read down each column and then to the right, your entry marked.",
            },
            neighbourhood: {
              ...MAP_LABELS,
              caption: `Entries ${fmt(LEVY_MINE - SPAN)} to ${fmt(LEVY_MINE + SPAN)}`,
              description: `The ${fmt(SPAN * 2 + 1)} entries around yours, one square each, yours marked.`,
            },
          }}
          neighbourhood={{
            span: SPAN,
            ledger: {
              caption: `Entries ${fmt(LEVY_MINE - 2)} to ${fmt(LEVY_MINE + 2)}, times UTC`,
              columns: { index: "Entry", time: "Time (UTC)", kind: "Kind", hash: "Entry hash" },
              fingerprintLabel: (e) => `Fingerprint of entry ${fmt(Number(e.index))}`,
              entries: ledgerAround(LEVY_BOARD, LEVY_MINE, 2),
            },
          }}
          entry={{
            title: `Entry ${fmt(LEVY_MINE)}`,
            hash: MINE_HASH,
            hashLabel: "Entry hash, as on your receipt",
            fingerprintLabel: `Fingerprint of entry ${fmt(LEVY_MINE)}, ${MINE_HASH.slice(0, 8)}`,
            facts: [
              { label: "Kind", value: "Ballot" },
              { label: "Recorded", value: `3 Nov 2026, ${MINE_TIME} UTC` },
              { label: "Segment", value: `${fmt(SEG.segment)}, 14:00–15:00 UTC` },
            ],
          }}
          proof={{ ...LEVY_PROOF, anchor, verdict, labels: PATH_LABELS }}
        />
      </Section>

      <Section
        index="06"
        mark="The proof"
        title="The path, hash by hash"
        lede={
          <>
            Each step pairs the hash computed so far with one the proof gives, on its side, and
            hashes the two. The bar under each step is the whole board: the proof&rsquo;s hash
            stands for the grey run of entries, yours for the green. Your browser did this from the
            published entry-hash lists; it never asked anyone about your entry.
          </>
        }
      >
        <InclusionPath {...LEVY_PROOF} anchor={anchor} verdict={verdict} labels={PATH_LABELS} />
        <p className="m-0 flex flex-wrap gap-x-8 gap-y-2">
          <a
            href="/board"
            className="inline-flex min-h-12 items-center gap-2 underline decoration-primary underline-offset-4"
          >
            Read the whole board <ArrowRight aria-hidden="true" className="size-4" />
          </a>
          <a
            href="/verify"
            className="inline-flex min-h-12 items-center gap-2 underline decoration-primary underline-offset-4"
          >
            Recount the poll yourself <ArrowRight aria-hidden="true" className="size-4" />
          </a>
        </p>
      </Section>
    </MockShell>
  );
}
