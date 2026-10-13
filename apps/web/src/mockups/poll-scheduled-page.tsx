import { buttonVariants, cn, Count, StatusTrail } from "@abolishus/ui";
import { CalendarClock, Check, Clock, FileCheck2, ShieldCheck, Smartphone } from "lucide-react";

import { TIERS, TRANSIT, TRUSTEES } from "./fixtures.ts";
import { TIER_VOTERS, TRANSIT_CEREMONY, TRANSIT_REGISTRY, tierInfo } from "./poll-data.ts";
import {
  BallotPreview,
  ClaimNote,
  Evidence,
  EvidenceHash,
  FactList,
  FactStrip,
  PollSection,
  SnapshotColumns,
  StatusMark,
} from "./poll-parts.tsx";
import { MockShell, PageHead } from "./shell.tsx";

const POLL = TRANSIT;

export function PollScheduledPage() {
  const posted = TRANSIT_CEREMONY.commitments.filter((c) => c === "posted").length;
  return (
    <MockShell current="/polls">
      <article>
        <PageHead
          eyebrow={`${POLL.kind} · ${POLL.title}`}
          title={POLL.question}
          className="pb-16"
          lede={`Voting opens on ${POLL.opens}. Until then there is nothing to vote on; this page sets out who will be able to vote and how the count will be protected.`}
        >
          <div className="flex flex-wrap items-center gap-3">
            <StatusMark icon={CalendarClock}>Scheduled</StatusMark>
          </div>
          <FactStrip
            className="mt-4"
            facts={[
              { term: "Who can vote", value: POLL.scope },
              { term: "Opens", value: POLL.opens },
              { term: "Closes", value: POLL.closes },
              { term: "Counting", value: `${POLL.method}: one choice per ballot` },
            ]}
          />
        </PageHead>

        <PollSection
          id="ballot"
          index="01"
          mark="The ballot"
          title="The question, as it will appear"
          lede={
            <p className="m-0">
              The wording is fixed by the poll's definition, which is already on the board. It can't
              be edited before or during voting.
            </p>
          }
        >
          <BallotPreview
            question={POLL.question}
            options={POLL.options}
            instruction="Choose one option."
            single
          />
        </PollSection>

        <PollSection
          id="electorate"
          index="02"
          mark="Electorate"
          title="Who is registered, tier by tier"
          lede={
            <>
              <p className="m-0">
                Accounts registered in the state at each verification tier, as of{" "}
                {TRANSIT_REGISTRY.asOf}. Results will be reported among each tier's own members, so
                these are the groups turnout will be measured against.
              </p>
              <p className="m-0">Weekly snapshots from the registry; the latest is highlighted.</p>
            </>
          }
        >
          <ul className="m-0 grid list-none gap-12 p-0">
            {TRANSIT_REGISTRY.tiers.map((t) => {
              const info = tierInfo(t.tier);
              const latest = t.weeks.at(-1)?.value ?? 0;
              const first = t.weeks[0]?.value ?? 0;
              return (
                <li
                  key={t.tier}
                  className="grid gap-6 border-t-2 border-foreground pt-4 md:grid-cols-12"
                >
                  <div className="grid content-start gap-2 md:col-span-5">
                    <h3 className="m-0 text-base font-medium">
                      {info.name} <span className="text-muted-foreground">· {info.short}</span>
                    </h3>
                    <p className="m-0 font-heading text-5xl leading-none font-semibold tabular-nums">
                      <Count value={latest} />
                    </p>
                    <p className="m-0 text-sm">
                      registered {TIER_VOTERS[t.tier]}, <Count value={latest - first} /> more than
                      four weeks earlier.
                    </p>
                  </div>
                  <SnapshotColumns
                    className="md:col-span-7"
                    caption={`Registered ${TIER_VOTERS[t.tier]}, weekly`}
                    points={t.weeks}
                    compact
                  />
                </li>
              );
            })}
          </ul>
        </PollSection>

        <PollSection
          id="get-verified"
          index="03"
          mark="Before it opens"
          title="Get verified for Tier 2 ahead of time"
          lede={
            <p className="m-0">
              Anyone with an account can vote at Tier 0. Verifying a document now means your ballot
              counts among document-verified voters from the moment voting opens.
            </p>
          }
        >
          <GetVerified />
        </PollSection>

        <PollSection
          id="ceremony"
          index="04"
          mark="Key ceremony"
          title="The trustees are making the election key"
          lede={
            <>
              <p className="m-0">
                Seven independent trustees jointly generate the key ballots are encrypted to. No one
                holds the whole key, including us: any {TRANSIT_CEREMONY.threshold} of the 7 can
                decrypt the final tally, and nothing else.
              </p>
              <p className="m-0">
                Every step is posted to the board, so anyone can check the transcript.
              </p>
            </>
          }
        >
          <div className="grid gap-12">
            <StatusTrail
              label="Key ceremony"
              stateLabels={{
                complete: "complete",
                pending: "in progress",
                upcoming: "not started",
              }}
              stepTemplate="{step}, {state}"
              steps={TRANSIT_CEREMONY.steps.map((step, i) => ({
                label: step.label,
                state: i === 0 ? "complete" : i === 1 ? "pending" : "upcoming",
                ...(step.detail === "" ? {} : { detail: step.detail }),
              }))}
            />
            <div className="grid gap-4">
              <h3 className="m-0 font-heading text-xl font-semibold">
                Commitments: {posted} of {TRUSTEES.length} posted
              </h3>
              <ol className="m-0 grid list-none border-t border-foreground p-0 text-sm">
                {TRUSTEES.map((t, i) => {
                  const done = TRANSIT_CEREMONY.commitments[i] === "posted";
                  return (
                    <li
                      key={t.key}
                      className="grid grid-cols-[1fr_auto] gap-x-4 border-b border-border py-3"
                    >
                      <span className="min-w-0">
                        <span className="block">{t.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t.kind}, {t.jurisdiction} · <code className="font-mono">{t.key}</code>
                        </span>
                      </span>
                      <span className="flex items-center gap-1.5 self-center text-xs">
                        {done ? (
                          <Check aria-hidden="true" className="size-4 text-recorded" />
                        ) : (
                          <Clock aria-hidden="true" className="size-4 text-pending" />
                        )}
                        {done ? "Posted" : "Awaiting"}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
            <EvidenceHash
              label={`Ceremony transcript so far · ${TRANSIT_CEREMONY.updated}`}
              value={TRANSIT_CEREMONY.transcript}
              subject="ceremony transcript"
            />
          </div>
        </PollSection>

        <PollSection
          id="definition"
          index="05"
          mark="Definition"
          title="What the poll commits to"
          lede={
            <ClaimNote>
              Everything here is what our server says about this poll. The verifier checks it
              against the election registry on Ethereum; this page doesn't.
            </ClaimNote>
          }
        >
          <div className="grid gap-10">
            <FactList
              facts={[
                { term: "Counting", value: "One choice" },
                { term: "Options", value: String(POLL.options.length) },
                { term: "Selections per ballot", value: "1 to 1" },
                {
                  term: "Who can vote",
                  value: (
                    <ul className="m-0 grid list-none gap-1 p-0">
                      {TIERS.map((t) => (
                        <li key={t.key}>
                          {t.short} ({t.name.toLowerCase()})
                        </li>
                      ))}
                    </ul>
                  ),
                },
                {
                  term: "Trustees needed to decrypt the tally",
                  value: `${TRANSIT_CEREMONY.threshold} of ${TRUSTEES.length}`,
                },
                { term: "Opens", value: POLL.opens },
                { term: "Closes", value: POLL.closes },
              ]}
            />
            <div className="grid gap-8 md:grid-cols-2">
              <EvidenceHash label="Election ID" value={POLL.id} subject="election" />
              <EvidenceHash
                label="Definition hash"
                value={POLL.definitionHash}
                subject="definition"
              />
            </div>
          </div>
        </PollSection>
      </article>
    </MockShell>
  );
}

function GetVerified() {
  const steps = [
    {
      icon: FileCheck2,
      title: "Have your document to hand",
      body: "A passport or a driving licence with a chip. Nothing else is needed.",
    },
    {
      icon: Smartphone,
      title: "Scan it with your phone",
      body: "The app reads the chip and checks the government's signature on your phone. The document never leaves it.",
    },
    {
      icon: ShieldCheck,
      title: "Send a proof, not the document",
      body: "Your phone sends a proof that the document is genuine and makes you eligible. We never see your name, number or photo.",
    },
  ];
  return (
    <div className="grid gap-12">
      <ol className="m-0 grid list-none gap-px border border-border bg-border p-0 md:grid-cols-3">
        {steps.map(({ icon: Icon, title, body }, i) => (
          <li key={title} className="grid content-start gap-3 bg-background p-5">
            <span className="flex items-center justify-between">
              <Icon aria-hidden="true" className="size-5" />
              <Evidence>Step {i + 1}</Evidence>
            </span>
            <span className="text-base font-medium">{title}</span>
            <span className="text-sm text-pretty text-muted-foreground">{body}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <a href="/account/verify" className={buttonVariants({ size: "lg" })}>
          Start document verification
        </a>
        <span className="text-sm text-muted-foreground">
          About five minutes. Needs a phone with NFC.
        </span>
      </div>
      <div className="grid gap-4">
        <h3 className="m-0 font-heading text-xl font-semibold">The three tiers</h3>
        <dl className="m-0 grid border-t border-foreground">
          {TIERS.map((t) => (
            <div
              key={t.key}
              className={cn(
                "grid gap-1 border-b border-border py-3 sm:grid-cols-[14rem_1fr] sm:gap-6",
              )}
            >
              <dt className="text-sm">
                <span className="font-medium">{t.short}</span> · {t.name}
              </dt>
              <dd className="m-0 text-sm text-muted-foreground">
                {t.description}
                {t.key === "tier1"
                  ? " If you can't use a document, ask two Tier 2 members to vouch for you."
                  : ""}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
