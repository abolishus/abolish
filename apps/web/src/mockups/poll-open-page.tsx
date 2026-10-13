import { buttonVariants, Count, Fingerprint, groupHex } from "@abolishus/ui";
import { CircleDot, EyeOff, KeyRound, ScanLine, Smartphone } from "lucide-react";

import { CLIENT_RELEASE, PARKS, TRUSTEES } from "./fixtures.ts";
import { PARKS_DELISTING, PARKS_LIVE, TIER_VOTERS, tierInfo } from "./poll-data.ts";
import {
  BallotPreview,
  ClaimNote,
  Evidence,
  EvidenceHash,
  FactList,
  FactStrip,
  num,
  pct,
  PollSection,
  SnapshotColumns,
  StatusMark,
} from "./poll-parts.tsx";
import { MockShell, PageHead } from "./shell.tsx";

const POLL = PARKS;

export function PollOpenPage({ delisted = false }: { delisted?: boolean }) {
  return (
    <MockShell current="/polls">
      <article>
        <PageHead eyebrow={`${POLL.kind} · ${POLL.title}`} title={POLL.question} className="pb-16">
          {delisted ? <DelistedNotice /> : null}
          <div className="flex flex-wrap items-center gap-3">
            <StatusMark icon={CircleDot}>Open for voting</StatusMark>
            {delisted ? (
              <StatusMark icon={EyeOff} tone="pending">
                Delisted
              </StatusMark>
            ) : null}
          </div>
          <FactStrip
            className="mt-4"
            facts={[
              { term: "Who can vote", value: POLL.scope },
              { term: "Opened", value: POLL.opens },
              { term: "Closes", value: POLL.closes },
              { term: "Counting", value: "Approval: choose any number" },
            ]}
          />
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <a href={`/ballot/${POLL.slug}`} className={buttonVariants({ size: "lg" })}>
              Vote in the ballot client
            </a>
            <a href="#how" className="text-sm underline underline-offset-4">
              What you'll need
            </a>
          </div>
        </PageHead>

        <PollSection
          id="ballot"
          index="01"
          mark="The ballot"
          title="As the ballot will show it"
          lede={
            <p className="m-0">
              The wording and order below are fixed by the poll's definition and can't change while
              voting is open. This is a preview: nothing on this site records a vote.
            </p>
          }
        >
          <BallotPreview
            question={POLL.question}
            options={POLL.options}
            instruction={`Choose any number of options: none, one, some or all ${POLL.options.length}.`}
          />
        </PollSection>

        <PollSection
          id="how"
          index="02"
          mark="How to vote"
          title="Voting happens in the ballot client"
          lede={
            <p className="m-0">
              The ballot client is a separate app that encrypts your choices on your device before
              anything is sent. Before you vote, check that its fingerprint matches the one here and
              on the release page.
            </p>
          }
        >
          <HowToVote />
        </PollSection>

        <PollSection
          id="participation"
          index="03"
          mark="Participation"
          title="Ballots so far, tier by tier"
          lede={
            <>
              <p className="m-0">
                Counts of encrypted ballots on the board, as of {PARKS_LIVE.asOf}. They update when
                you reload the page.
              </p>
              <p className="m-0">
                What the ballots say stays sealed until voting closes and the trustees decrypt the
                tally. Nobody, including us, can see a running result.
              </p>
            </>
          }
        >
          <Participation />
        </PollSection>

        <PollSection
          id="definition"
          index="04"
          mark="Definition"
          title="What the poll commits to"
          lede={
            <ClaimNote>
              Everything here is what our server says about this poll. The verifier checks it
              against the election registry on Ethereum; this page doesn't.
            </ClaimNote>
          }
        >
          <Definition />
        </PollSection>
      </article>
    </MockShell>
  );
}

function DelistedNotice() {
  return (
    <div role="note" className="grid max-w-prose gap-2 border-l-4 border-pending ps-4">
      <p className="m-0 font-heading text-lg font-semibold">This poll is delisted</p>
      <p className="m-0 text-sm text-pretty">
        It is left out of discovery and search. Reason: {PARKS_DELISTING.reason}.{" "}
        {PARKS_DELISTING.note} Voting, the board and the result are unaffected.
      </p>
      <p className="m-0 font-mono text-xs text-muted-foreground">
        Logged {PARKS_DELISTING.at} · moderation log entry <Count value={PARKS_DELISTING.entry} />
      </p>
      <a className="justify-self-start text-sm underline underline-offset-4" href="/moderation">
        See the moderation log
      </a>
    </div>
  );
}

function HowToVote() {
  const needs = [
    {
      icon: Smartphone,
      title: "A phone or computer",
      body: "Any current browser. The client works offline once loaded.",
    },
    {
      icon: KeyRound,
      title: "Your passkey",
      body: "The one on your Abolish account. It proves you're eligible, not who you voted for.",
    },
    {
      icon: ScanLine,
      title: "For Tier 2, your verified document",
      body: "Only if you verified one already. You can vote at a lower tier without it.",
    },
  ];
  return (
    <div className="grid gap-12">
      <ol className="m-0 grid list-none gap-0 border-t border-foreground p-0">
        {[
          "Open the ballot client from this page or any entry point.",
          "Compare its fingerprint with the one below. If they differ, stop.",
          "Sign in with your passkey and make your choices.",
          "Review, cast, and keep your receipt. It shows your ballot is on the board.",
        ].map((step, i) => (
          <li
            key={step}
            className="grid grid-cols-[3rem_1fr] items-baseline border-b border-border py-4"
          >
            <span className="font-mono text-sm tabular-nums">{String(i + 1).padStart(2, "0")}</span>
            <span className="text-base text-pretty">{step}</span>
          </li>
        ))}
      </ol>
      <div className="grid gap-6 border border-border p-5 sm:grid-cols-[auto_1fr] sm:p-6">
        <Fingerprint
          value={CLIENT_RELEASE.hash}
          label={`Fingerprint of ballot client ${CLIENT_RELEASE.hash.slice(0, 4)} ${CLIENT_RELEASE.hash.slice(4, 8)}`}
          size={112}
        />
        <div className="grid min-w-0 content-start gap-3">
          <h3 className="m-0 font-heading text-xl font-semibold">
            Ballot client {CLIENT_RELEASE.version}
          </h3>
          <div className="grid gap-1">
            <Evidence>Release hash</Evidence>
            <code translate="no" className="font-mono text-xs/relaxed break-all">
              {groupHex(CLIENT_RELEASE.hash).map((g, i) => (
                <span key={i} className="mr-[0.5ch] last:mr-0">
                  {g}
                </span>
              ))}
            </code>
          </div>
          <div className="grid gap-1">
            <Evidence>IPFS</Evidence>
            <code className="font-mono text-xs break-all">{CLIENT_RELEASE.cid}</code>
          </div>
          <p className="m-0 text-sm text-muted-foreground">
            Signed and reproducible. The client shows the same glyph on its first screen.
          </p>
        </div>
      </div>
      <div className="grid gap-4">
        <h3 className="m-0 font-heading text-xl font-semibold">What you'll need</h3>
        <ul className="m-0 grid list-none gap-px border border-border bg-border p-0 md:grid-cols-3">
          {needs.map(({ icon: Icon, title, body }) => (
            <li key={title} className="grid content-start gap-2 bg-background p-5">
              <Icon aria-hidden="true" className="size-5" />
              <span className="text-base font-medium">{title}</span>
              <span className="text-sm text-muted-foreground">{body}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Participation() {
  return (
    <ul className="m-0 grid list-none gap-12 p-0">
      {PARKS_LIVE.tiers.map((t) => {
        const info = tierInfo(t.tier);
        return (
          <li key={t.tier} className="grid gap-6 border-t-2 border-foreground pt-4 md:grid-cols-12">
            <div className="grid content-start gap-2 md:col-span-5">
              <h3 className="m-0 text-base font-medium">
                {info.name} <span className="text-muted-foreground">· {info.short}</span>
              </h3>
              <p className="m-0 font-heading text-5xl leading-none font-semibold tabular-nums">
                <Count value={t.ballots} />
              </p>
              <p className="m-0 text-sm">
                {TIER_VOTERS[t.tier]} have voted: {pct(t.ballots / t.eligible)} of{" "}
                <Count value={t.eligible} /> eligible.
              </p>
              <p className="m-0 font-mono text-xs text-muted-foreground">As of {PARKS_LIVE.asOf}</p>
            </div>
            <SnapshotColumns
              className="md:col-span-7"
              caption={`New ${TIER_VOTERS[t.tier].replace(" voters", "")} ballots per day`}
              points={t.days}
            />
          </li>
        );
      })}
    </ul>
  );
}

function Definition() {
  return (
    <div className="grid gap-10">
      <FactList
        facts={[
          { term: "Counting", value: "Approve any number" },
          { term: "Options", value: num(POLL.options.length) },
          { term: "Selections per ballot", value: `0 to ${POLL.options.length}` },
          {
            term: "Who can vote",
            value: (
              <ul className="m-0 grid list-none gap-1 p-0">
                {PARKS_LIVE.tiers.map((t) => (
                  <li key={t.tier}>
                    {tierInfo(t.tier).short} ({tierInfo(t.tier).name.toLowerCase()}):{" "}
                    <Count value={t.eligible} /> members
                  </li>
                ))}
              </ul>
            ),
          },
          {
            term: "Trustees needed to decrypt the tally",
            value: `4 of ${TRUSTEES.length}`,
          },
          { term: "Opens", value: POLL.opens },
          { term: "Closes", value: POLL.closes },
        ]}
      />
      <div className="grid gap-8 md:grid-cols-2">
        <EvidenceHash label="Definition hash" value={POLL.definitionHash} subject="definition" />
        <EvidenceHash label="Board head" value={PARKS_LIVE.boardHead} subject="board head" />
      </div>
      <p className="m-0 text-sm text-muted-foreground">
        <Count value={POLL.entries} /> board entries. Until an Ethereum anchor covers the board
        head, it is only this server's word; keep it, and a later board that doesn't extend it is
        evidence of tampering.
      </p>
    </div>
  );
}
