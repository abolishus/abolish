import {
  BoardLedger,
  BoardMap,
  Button,
  Fingerprint,
  InclusionPath,
  type BoardMapLabels,
  type InclusionPathLabels,
} from "@abolishus/ui";
import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { BOARD, fmt, MINE, MINE_SEGMENT, PROOF, rowsUpTo, SIZE } from "./everyday-place-data.ts";
import { EVERYDAY_RECEIPT, EVERYDAY_SEALED, type EverydayPoll } from "./everyday-fixtures.ts";
import {
  EVERYDAY_ACTION,
  EverydayFrame,
  EverydayTitle,
  Note,
  OneTapAway,
  Part,
} from "./everyday-frame.tsx";
import { shortHex } from "./fixtures.ts";

const DAYS = new Set(BOARD.segments.map((s) => s.group)).size;

const MAP: BoardMapLabels = {
  caption: `The public board, ${fmt(SIZE)} answers, newest last`,
  description:
    "Each answer as one small square, in the order they arrived: each hour's answers form a block, and yours is the last square.",
  kinds: {
    ballot: "Answers",
    spoiled: "Checked and set aside",
    trustee: "Key holders' records",
    event: "Records from Ethereum",
  },
  anchored: "Written to Ethereum",
  unanchored: "Not written yet",
  mine: "Yours",
  positionPending:
    "Yours is number {index}, the newest of {total}. It arrived in the {segment} hour, which is written to Ethereum at 15:00.",
  table: {
    summary: "Every hour as a list",
    caption: "Answers per hour, UTC",
    segment: "Hour",
    entries: "Answers",
    anchor: "Written to Ethereum",
    notAnchored: "At 15:00",
    breakdown: "{kind}: {count}",
    anchorCell: "{at}",
  },
};

const PATH: InclusionPathLabels = {
  caption: `How your phone checked number ${fmt(MINE)}`,
  leaf: "Your answers",
  entryHash: "Their fingerprint",
  leafHash: "Leaf",
  step: "Step {step} of {total}",
  given: "From the board",
  computed: "Worked out",
  range: "answers {from}–{to}",
  single: "answer {index}",
  count: { one: "{count} answer", other: "{count} answers" },
  root: "One fingerprint for all {size}",
  anchoredRoot: "In your receipt",
  verdict: {
    verified: "They match, and it's written to Ethereum.",
    mismatch: "They don't match. Your phone keeps your answers and sends them again.",
    pending:
      "They match: the board your phone was shown holds your answers. At 15:00 that board is written to Ethereum, and your phone checks it again.",
  },
  fingerprint: "Fingerprint of {what}, {hash}",
  levels: {
    one: "{count} step from your answers to all {size}",
    other: "{count} steps from your answers to all {size}",
  },
  full: "Every fingerprint in full",
  sides: { left: "on the left", right: "on the right" },
};

const ANCHOR = {
  root: PROOF.root,
  size: SIZE,
  title: "The board in your receipt",
  facts: [
    { label: "Signed", value: "7 Nov, 14:02:12 UTC" },
    { label: "Written to Ethereum", value: "At 15:00 UTC" },
  ],
};

function Place({ poll, onBack }: { poll: EverydayPoll; onBack: () => void }) {
  return (
    <EverydayFrame
      poll={poll}
      primary={
        <Button size="lg" className={EVERYDAY_ACTION} onClick={onBack}>
          Done
        </Button>
      }
    >
      <EverydayTitle title="Your place on the board">
        <p className="m-0">
          Your answers are the newest of {fmt(SIZE)} on the public board, from {DAYS} days of this
          poll. They&rsquo;re sealed: the board shows they arrived, never what they say.
        </p>
      </EverydayTitle>
      <Part title="Every answer, one square each">
        <BoardMap
          kinds={BOARD.kinds}
          segments={BOARD.segments}
          mine={MINE}
          labels={MAP}
          maxHeight={300}
          maxCell={8}
        />
      </Part>
      <Part title="Around yours">
        <p className="m-0">
          The answers before yours are other people&rsquo;s, sealed like yours. Number{" "}
          {fmt(EVERYDAY_SEALED.spoiledEntry)} is the set you checked before sending: set aside,
          never counted.
        </p>
        <BoardLedger
          caption={`Numbers ${fmt(MINE - 4)} to ${fmt(MINE)}, times UTC`}
          columns={{ index: "Number", time: "Arrived", kind: "What", hash: "Fingerprint" }}
          fingerprintLabel={(e) => `Fingerprint of number ${fmt(Number(e.index))}`}
          entries={rowsUpTo(5)}
          highlight={MINE}
        />
      </Part>
      <Part title="How your phone checked it">
        <p className="m-0">
          Before saying your answers were in, your phone took their fingerprint and{" "}
          {PROOF.siblings.length} more from the board, and worked out the one fingerprint for all{" "}
          {fmt(SIZE)} answers. It matches the one in your receipt.
        </p>
        <InclusionPath
          {...PROOF}
          anchor={ANCHOR}
          verdict="pending"
          labels={PATH}
          variant="compact"
        />
        <OneTapAway summary={<span className="font-medium">Every step</span>}>
          <InclusionPath
            {...PROOF}
            anchor={ANCHOR}
            verdict="pending"
            labels={{ ...PATH, caption: "Every step, from your answers to all of them" }}
          />
        </OneTapAway>
      </Part>
      <Part title="What happens at 15:00">
        <Note title={`The ${MINE_SEGMENT.label} hour is written to Ethereum`}>
          <p className="m-0">
            Then anyone can check the board against it, without us. Your phone checks again in the
            background that your answers are part of what was written, and tells you if they
            aren&rsquo;t.
          </p>
        </Note>
      </Part>
    </EverydayFrame>
  );
}

/** The Done screen's evidence step, as it would sit under "Keep your receipt". */
function FromDone({ poll, onSee }: { poll: EverydayPoll; onSee: () => void }) {
  return (
    <EverydayFrame poll={poll}>
      <div className="flex items-center gap-4">
        <Fingerprint
          value={EVERYDAY_RECEIPT.hash}
          label={`Seal of your receipt, ${shortHex(EVERYDAY_RECEIPT.hash)}`}
          size={48}
        />
        <h1 className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
          Your answers are in
        </h1>
      </div>
      <Part title="On the public board">
        <p className="m-0">
          They&rsquo;re number {fmt(MINE)}, the newest of {fmt(SIZE)}. Anyone can see they arrived;
          no one can see what they say.
        </p>
        <div>
          <Button size="lg" variant="outline" className={EVERYDAY_ACTION} onClick={onSee}>
            See your place on the board
            <ArrowRight aria-hidden="true" data-icon="inline-end" />
          </Button>
        </div>
      </Part>
    </EverydayFrame>
  );
}

export interface EverydayPlaceProps {
  poll: EverydayPoll;
  start?: "done" | "place";
}

/** "See your place on the board", from the Done screen: still, phone-first, the same true board. */
export function EverydayPlace({ poll, start = "done" }: EverydayPlaceProps) {
  const [view, setView] = useState(start);
  if (view === "place") return <Place poll={poll} onBack={() => setView("done")} />;
  return <FromDone poll={poll} onSee={() => setView("place")} />;
}
