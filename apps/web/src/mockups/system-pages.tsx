import { Button, Fingerprint, SectionMark } from "@abolishus/ui";
import { ArrowRight, RotateCw } from "lucide-react";
import type { ReactNode } from "react";

import { CLIENT_RELEASE, ENTRY_POINTS, LEVY } from "./fixtures.ts";
import { Frame, MockShell } from "./shell.tsx";

function SystemHead({
  code,
  title,
  children,
}: {
  code: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto grid max-w-6xl gap-8 px-4 pt-16 pb-12 md:pt-28 lg:grid-cols-12">
      <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase lg:col-span-12">
        {code}
      </p>
      <h1 className="m-0 font-heading text-5xl leading-[1.02] font-semibold tracking-tight text-balance sm:text-7xl lg:col-span-9">
        {title}
      </h1>
      <div className="grid max-w-prose gap-4 text-lg text-pretty lg:col-span-7">{children}</div>
    </div>
  );
}

const WAYS = [
  { href: "/polls", label: "Polls", note: "Open, scheduled and counted polls" },
  { href: "/board", label: "The board", note: "Every entry, in order" },
  { href: "/verify", label: "Verify", note: "Find your receipt or recount a poll" },
  { href: "/", label: "Home", note: "Start again from the front page" },
] as const;

function WayList({ label }: { label: string }) {
  return (
    <nav aria-label={label}>
      <ul className="m-0 grid list-none border-t-2 border-foreground p-0 sm:grid-cols-2">
        {WAYS.map((w) => (
          <li key={w.href} className="border-b border-border sm:odd:border-e">
            <a
              href={w.href}
              className="group grid min-h-12 grid-cols-[1fr_auto] items-center gap-x-4 px-1 py-5 hover:bg-muted sm:px-5"
            >
              <span className="grid gap-0.5">
                <span className="text-lg font-semibold">{w.label}</span>
                <span className="text-sm text-muted-foreground group-hover:text-foreground">
                  {w.note}
                </span>
              </span>
              <ArrowRight aria-hidden="true" className="size-5" />
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function NotFoundPage() {
  return (
    <MockShell>
      <SystemHead code="404 · Not found" title="There is no page at this address">
        <p className="m-0">
          The link may be mistyped, or the page may have moved. Nothing on the record has been
          removed: board entries, definitions and results are permanent.
        </p>
        <p className="m-0 text-base">
          If you were looking for a poll, its 64-character ID finds it on the{" "}
          <a href="/verify" className="underline underline-offset-4">
            verify page
          </a>
          , here or through any other entry point.
        </p>
      </SystemHead>
      <Frame>
        <WayList label="Other places to go" />
      </Frame>
    </MockShell>
  );
}

export function ErrorPage() {
  return (
    <MockShell>
      <SystemHead code="Error" title="Something went wrong on our side">
        <p className="m-0">
          This page couldn’t be shown. Try again in a moment, or go somewhere else below. This
          website never handles ballots: if you were voting, your ballot and receipt are safe in the
          ballot client on your device.
        </p>
        <div>
          <Button size="lg" onClick={() => window.location.reload()}>
            <RotateCw aria-hidden="true" data-icon="inline-start" />
            Try again
          </Button>
        </div>
      </SystemHead>
      <Frame>
        <WayList label="Other places to go" />
      </Frame>
    </MockShell>
  );
}

export function UnreachablePage() {
  return (
    <MockShell>
      <SystemHead code="Offline · Served from a mirror" title="Our servers are unreachable">
        <p className="m-0">
          You are reading a copy of this page that doesn’t depend on them. The record does not
          depend on them either: every ballot, proof and result is anchored on Ethereum and mirrored
          on IPFS, and can be checked and recounted without us.
        </p>
      </SystemHead>

      <Frame className="grid gap-20">
        <section aria-labelledby="survives-title" className="grid gap-8">
          <div className="grid gap-4">
            <SectionMark index="01">The record</SectionMark>
            <h2
              id="survives-title"
              className="m-0 font-heading text-3xl font-semibold tracking-tight sm:text-4xl"
            >
              What survives while we are down
            </h2>
          </div>
          <ol className="m-0 grid list-none border-t-2 border-foreground p-0 md:grid-cols-3">
            {[
              {
                where: "Ethereum L1",
                what: "The board’s Merkle root, anchored every hour. The final check on everything below.",
              },
              {
                where: "The L2",
                what: "Poll definitions, trustee keys, the groups of eligible voters, and ballots submitted directly.",
              },
              {
                where: "IPFS and the archive",
                what: "Every encrypted ballot, proof and transcript, in full, mirrored by us and by others.",
              },
            ].map((s) => (
              <li
                key={s.where}
                className="grid content-start gap-2 border-b border-border py-6 md:border-e md:border-b-0 md:px-6 md:first:ps-0 md:last:border-e-0"
              >
                <h3 className="m-0 font-mono text-xs tracking-widest uppercase">{s.where}</h3>
                <p className="m-0 text-base text-pretty">{s.what}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="entry-title" className="grid gap-8">
          <div className="grid gap-4">
            <SectionMark index="02">Entry points</SectionMark>
            <h2
              id="entry-title"
              className="m-0 font-heading text-3xl font-semibold tracking-tight sm:text-4xl"
            >
              Other ways in
            </h2>
            <p className="m-0 max-w-prose text-base">
              The same site, served from elsewhere. One of these may work when the others don’t.
            </p>
          </div>
          <ul className="m-0 grid list-none border-t-2 border-foreground p-0">
            {ENTRY_POINTS.map((e) => (
              <li
                key={e.name}
                className="grid gap-1 border-b border-border py-4 sm:grid-cols-[14rem_1fr] sm:items-baseline"
              >
                <span className="font-mono text-base font-semibold">{e.name}</span>
                <span className="text-sm">{e.note}</span>
              </li>
            ))}
            <li className="grid gap-1 border-b border-border py-4 sm:grid-cols-[14rem_1fr] sm:items-baseline">
              <span className="font-mono text-base font-semibold">Ballot client on IPFS</span>
              <span className="grid gap-1 text-sm">
                Version {CLIENT_RELEASE.version}, from any IPFS gateway or your own node:
                <code className="font-mono text-xs break-all">ipfs://{CLIENT_RELEASE.cid}</code>
              </span>
            </li>
          </ul>
          <div className="flex items-center gap-4">
            <Fingerprint
              value={CLIENT_RELEASE.hash}
              label={`Fingerprint of ballot client ${CLIENT_RELEASE.hash.slice(0, 8)}`}
              size={56}
            />
            <p className="m-0 max-w-prose text-sm text-pretty">
              Whichever way you reach the ballot client, its fingerprint should match this one and
              the one published with the release. If it doesn’t, don’t use it.
            </p>
          </div>
        </section>

        <div className="grid gap-16 md:grid-cols-2 md:gap-10">
          <section aria-labelledby="verify-title" className="grid content-start gap-4">
            <SectionMark index="03">Verify</SectionMark>
            <h2
              id="verify-title"
              className="m-0 font-heading text-3xl font-semibold tracking-tight"
            >
              Recount without us
            </h2>
            <p className="m-0 text-base text-pretty">
              The verifier reads the board from IPFS and the anchors from Ethereum, checks every
              proof and recounts each tier. It needs no server of ours, only a copy of the verifier
              and a connection to Ethereum and IPFS.
            </p>
            <pre className="m-0 border border-border p-4 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
              <code>abolish-verify --poll {LEVY.id}</code>
            </pre>
          </section>
          <section aria-labelledby="direct-title" className="grid content-start gap-4">
            <SectionMark index="04">Vote</SectionMark>
            <h2
              id="direct-title"
              className="m-0 font-heading text-3xl font-semibold tracking-tight"
            >
              Cast a ballot without us
            </h2>
            <p className="m-0 text-base text-pretty">
              If a poll is open, the ballot client can send your encrypted ballot straight to the
              contract on the L2: the direct-submit path. It counts exactly like any other ballot.
            </p>
            <p className="m-0 text-base text-pretty">
              You pay the network fee yourself, in ETH. The paying address is public, so pay from
              one that isn’t linked to you.
            </p>
            <p className="m-0 text-base text-pretty">
              The poll still closes at its published time. Our outage doesn’t pause it, and we can’t
              extend it.
            </p>
          </section>
        </div>
      </Frame>
    </MockShell>
  );
}
