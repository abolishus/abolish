import { Fingerprint, Hash, ScrollScene, cn } from "@abolishus/ui";
import { ArrowRight, Check, Circle } from "lucide-react";

import { short } from "./board-data.ts";
import { CopyBlock, Micro, Section } from "./board-parts.tsx";
import { CLIENT_RELEASE, ENTRY_POINTS, LEVY } from "./fixtures.ts";
import { MockShell, PageHead } from "./shell.tsx";

const VERSION = "1.0.0";
const OUT = "alder-levy/";

interface Stage {
  spec: string;
  title: string;
  text: string;
  /** What the recorded run printed for this check. */
  result: string;
}

const STAGES: readonly Stage[] = [
  {
    spec: "1",
    title: "The ballot client matches its signed release",
    text: "It hashes the client each entry point serves and checks the hash against release 1.4.0, signed by the release key and pinned to IPFS. A tampered client would fail here, before any ballot is read.",
    result: `client ${short(CLIENT_RELEASE.hash)} = release 1.4.0`,
  },
  {
    spec: "2",
    title: "The election definition",
    text: "It decodes the definition byte by byte, checks it is well formed, and compares its hash with the one the election registry on Ethereum holds. The question, options, window and trustees can't have changed since publication.",
    result: `definition ${short(LEVY.definitionHash)} = registry`,
  },
  {
    spec: "4.1",
    title: "The board's hash chain",
    text: "Every entry names the hash of the one before it. The verifier walks all 161,874 entries of the levy's board and recomputes each link, ending at the board head.",
    result: `161,874 links, head ${short(LEVY.boardHead)}`,
  },
  {
    spec: "4.2",
    title: "The Merkle tree and inclusion proofs",
    text: "It rebuilds the Merkle tree over the same entries. Every root matches, so every voter's inclusion proof resolves to a root that was anchored, and no entry was dropped or reordered.",
    result: "16 roots rebuilt, all match",
  },
  {
    spec: "4.3",
    title: "The anchors on Ethereum",
    text: "It reads every checkpoint anchored for the election straight from Ethereum: 16 hourly anchors, each on time, none conflicting, the last one sealing the board at its final size.",
    result: "16 anchors, sealed at 161,874",
  },
  {
    spec: "7",
    title: "The tally and decryption proofs",
    text: "It adds up the 161,363 admitted ballots, tier by tier, and checks each trustee's decryption share against its proof: 4 of 7 shares were needed and 4 were published. The result matches the published tally in all three tiers.",
    result: "3 tiers match · 4 of 4 shares valid",
  },
];

function Report({ step }: { step: number }) {
  const done = step === STAGES.length - 1;
  return (
    <figure
      data-testid="verifier-report"
      data-step={step}
      aria-label="Report of a recorded run against the Alder County library levy"
      className="m-0 grid border border-foreground bg-background"
    >
      <figcaption className="grid gap-1 border-b border-foreground p-4">
        <code translate="no" className="font-mono text-sm">
          $ abolish-verify check {OUT}
        </code>
        <span className="font-mono text-xs text-muted-foreground">
          Recorded run, 3 Nov 2026, 22:14 UTC · verifier {VERSION}
        </span>
      </figcaption>
      <ol className="m-0 grid list-none p-0">
        {STAGES.map((stage, i) => {
          const passed = i <= step;
          return (
            <li
              key={stage.spec}
              aria-current={i === step ? "step" : undefined}
              className={cn(
                "grid grid-cols-[2.5rem_1fr_auto] items-start gap-x-3 gap-y-1 border-b border-border border-l-4 border-l-transparent px-3 py-3 font-mono text-xs motion-safe:transition-colors motion-safe:duration-300",
                i === step && "border-l-primary",
              )}
            >
              <span className="text-muted-foreground tabular-nums">{stage.spec}</span>
              <span className={passed ? "text-foreground" : "text-muted-foreground"}>
                {stage.title}
              </span>
              <span
                className={cn(
                  "flex items-center gap-1.5",
                  passed ? "text-recorded" : "text-muted-foreground",
                )}
              >
                {passed ? (
                  <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
                ) : (
                  <Circle aria-hidden="true" className="size-3.5" />
                )}
                {passed ? "pass" : "not read yet"}
              </span>
              {passed ? (
                <span className="col-start-2 col-end-4 break-all text-muted-foreground">
                  {stage.result}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="m-0 flex flex-wrap items-baseline justify-between gap-2 p-4 font-mono text-sm">
        <span>
          Verdict:{" "}
          <span className={done ? "font-semibold" : ""}>{done ? "verified" : "reading…"}</span>
        </span>
        <span className="text-xs text-muted-foreground">
          {done ? "exit code 0" : `${step + 1} of ${STAGES.length} checks read`}
        </span>
      </p>
    </figure>
  );
}

const EXIT_CODES = [
  { code: 0, verdict: "Verified", meaning: "Every check passed." },
  { code: 20, verdict: "Failed", meaning: "A check failed. The report says which, and why." },
  {
    code: 21,
    verdict: "Unverifiable",
    meaning: "Something couldn't be checked, such as a missing copy. Never counted as a pass.",
  },
  { code: 22, verdict: "Bundle rejected", meaning: "The downloaded files were malformed." },
];

export function VerifyPage() {
  return (
    <MockShell current="/verify">
      <PageHead
        eyebrow="Verify it yourself"
        title="Recount any election without us"
        lede="The verifier is a small open-source program. It reads a poll's board from IPFS and its anchors from Ethereum, checks every proof, and gives the same answer whoever runs it. Nothing it does depends on our servers."
      >
        <nav aria-label="On this page" className="mt-4 border-t border-foreground pt-4">
          <ol className="m-0 grid list-none gap-x-6 gap-y-1 p-0 text-sm sm:grid-cols-2 md:grid-cols-5">
            {[
              { href: "#run", label: "Install and run" },
              { href: "#checks", label: "What it checks" },
              { href: "#entry-points", label: "Entry points" },
              { href: "#client", label: "Your ballot client" },
              { href: "#node", label: "Run a node" },
            ].map(({ href, label }, i) => (
              <li key={href}>
                <a
                  href={href}
                  className="flex min-h-12 items-center gap-3 underline-offset-4 hover:underline"
                >
                  <span className="font-mono text-xs text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {label}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </PageHead>

      <Section
        id="run"
        index="01"
        mark="Install and run"
        title="Three commands, one verdict"
        lede="The verifier needs Node.js 22 or later, an Ethereum node or RPC provider you trust, and any IPFS gateway. It never contacts abolish.us."
      >
        <div className="grid gap-12 md:grid-cols-12 md:gap-x-6">
          <ol className="m-0 grid list-none gap-8 p-0 md:col-span-7">
            {[
              {
                title: "Install the verifier",
                command: `npm install --global @abolishus/verifier@${VERSION}`,
              },
              {
                title: "Download the levy's board and anchors",
                command: `abolish-verify fetch ${LEVY.id} --ethereum https://your-node.example --out ${OUT}`,
              },
              { title: "Check everything", command: `abolish-verify check ${OUT}` },
            ].map((step, i) => (
              <li key={step.title} className="grid gap-3">
                <h3 className="m-0 flex items-baseline gap-3 font-heading text-lg font-semibold">
                  <span className="font-mono text-xs text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {step.title}
                </h3>
                <CopyBlock label={step.title} command={step.command} />
              </li>
            ))}
          </ol>
          <div className="grid content-start gap-4 md:col-span-5">
            <table className="w-full border-collapse text-sm">
              <caption className="pb-3 text-start font-mono text-xs tracking-wide text-muted-foreground uppercase">
                What the exit code means
              </caption>
              <thead>
                <tr className="border-y border-foreground">
                  <th scope="col" className="py-2 pe-4 text-start font-medium">
                    Code
                  </th>
                  <th scope="col" className="py-2 text-start font-medium">
                    Verdict
                  </th>
                </tr>
              </thead>
              <tbody>
                {EXIT_CODES.map((row) => (
                  <tr key={row.code} className="border-b border-border align-top">
                    <td className="py-3 pe-4 font-mono tabular-nums">{row.code}</td>
                    <td className="py-3">
                      <span className="block font-medium">{row.verdict}</span>
                      <span className="block text-muted-foreground">{row.meaning}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="m-0 text-sm text-muted-foreground">
              Prefer another language? The verifier&rsquo;s specification is public, and enough to
              write your own from scratch.{" "}
              <a
                href="https://github.com/abolishus/abolish/blob/main/docs/spec/verifier.md"
                className="text-foreground underline underline-offset-4"
              >
                Read the specification
              </a>
            </p>
          </div>
        </div>
      </Section>

      <Section
        id="checks"
        index="02"
        mark="What it checks"
        title="Six checks, from the code you ran to the count"
        lede="A recorded run against the Alder County library levy. Scroll on: each check is shown as the run reported it, in the order it ran."
      >
        <ScrollScene
          label="The verifier's checks, in order"
          steps={STAGES.map((stage) => (
            <div key={stage.spec} className="grid gap-3">
              <Micro>Specification § {stage.spec}</Micro>
              <h3 className="m-0 font-heading text-2xl leading-tight font-semibold">
                {stage.title}
              </h3>
              <p className="m-0 text-base text-pretty">{stage.text}</p>
            </div>
          ))}
          graphic={(step) => <Report step={step} />}
        />
      </Section>

      <Section
        id="entry-points"
        index="03"
        mark="Entry points"
        title="Three ways in, one record"
        lede="The site and the ballot client are published at three addresses run under different authorities, so one taken down or tampered with doesn't take the record with it."
      >
        <ul className="m-0 grid list-none border-y border-foreground p-0 md:grid-cols-3 md:divide-x md:divide-border">
          {ENTRY_POINTS.map((entry, i) => (
            <li
              key={entry.name}
              className="reveal grid content-start gap-3 border-b border-border py-6 last:border-b-0 md:border-b-0 md:px-6 md:first:ps-0 md:last:pe-0"
            >
              <Micro>{i === 0 ? "Primary" : `Entry point ${i + 1}`}</Micro>
              <p className="m-0 font-mono text-xl break-all">{entry.name}</p>
              <p className="m-0 text-sm text-muted-foreground">{entry.note}</p>
            </li>
          ))}
        </ul>
        <p className="m-0 max-w-prose text-base text-pretty">
          All three serve the same signed ballot client. If they ever disagree, trust none of them
          until the verifier says which one matches the release.
        </p>
      </Section>

      <Section
        id="client"
        index="04"
        mark="Your ballot client"
        title="Check the client you were served"
        lede="The ballot client is the code that encrypts your vote, so it is the one thing worth checking before you cast."
      >
        <div className="grid gap-12 md:grid-cols-12 md:gap-x-6">
          <figure
            aria-label={`Ballot client release ${CLIENT_RELEASE.version}`}
            className="reveal m-0 grid min-w-0 content-start justify-items-start gap-5 border-t-2 border-foreground pt-4 md:col-span-5"
          >
            <figcaption className="grid gap-1">
              <span className="font-heading text-2xl font-semibold">
                Release {CLIENT_RELEASE.version}
              </span>
              <span className="text-sm text-muted-foreground">
                Signed, reproducible, pinned to IPFS
              </span>
            </figcaption>
            <Fingerprint
              value={CLIENT_RELEASE.hash}
              label={`Fingerprint of ballot client ${CLIENT_RELEASE.version}, ${CLIENT_RELEASE.hash.slice(0, 4)} ${CLIENT_RELEASE.hash.slice(4, 8)}`}
              size={152}
            />
            <div className="min-w-0 [&_code]:text-sm">
              <Hash value={CLIENT_RELEASE.hash} label="Client hash" />
            </div>
            <p className="m-0 grid min-w-0 gap-1">
              <span className="text-sm text-muted-foreground">IPFS content ID</span>
              <code translate="no" className="font-mono text-sm break-all">
                {CLIENT_RELEASE.cid}
              </code>
            </p>
          </figure>
          <div className="grid content-start gap-8 md:col-span-6 md:col-start-7">
            <ol className="m-0 grid list-none border-t border-foreground p-0">
              {[
                {
                  title: "Look at the client's own fingerprint",
                  body: "In the ballot client, open About this client. It shows the fingerprint and hash of the code your browser actually loaded.",
                },
                {
                  title: "Compare it with this one",
                  body: "Same shapes in the same places, and the same hash. Check it against the release page on GitHub too, so you aren't trusting this page alone.",
                },
                {
                  title: "Or let the verifier compare every byte",
                  body: "It downloads what the address serves, hashes it, and checks the signature on the release.",
                },
              ].map((step, i) => (
                <li
                  key={step.title}
                  className="grid grid-cols-[2rem_1fr] gap-x-3 gap-y-1 border-b border-border py-5"
                >
                  <span className="font-mono text-xs text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h3 className="m-0 text-base font-semibold">{step.title}</h3>
                  <p className="col-start-2 m-0 text-sm text-pretty text-muted-foreground">
                    {step.body}
                  </p>
                </li>
              ))}
            </ol>
            <CopyBlock
              label="Check a served client"
              command={`abolish-verify client https://abolish.us/ballot/ --release ${CLIENT_RELEASE.version}`}
            />
          </div>
        </div>
      </Section>

      <Section
        id="node"
        index="05"
        mark="Community node"
        title="Run a node, keep a copy"
        lede="A community node is the verifier plus an IPFS node and a chain reader, with no database and no account. Each one running is another copy of the record that doesn't depend on us."
      >
        <div className="grid gap-12 md:grid-cols-12 md:gap-x-6">
          <div className="md:col-span-7">
            <CopyBlock
              label="Start a community node"
              command={`docker run --rm -p 8080:8080 -v abolish-node:/data ghcr.io/abolishus/node:${CLIENT_RELEASE.version} --ethereum https://your-node.example`}
            />
          </div>
          <dl className="m-0 grid content-start gap-0 border-t border-foreground md:col-span-5">
            {[
              {
                term: "Verifies",
                detail: "Every poll you follow, again after each hourly anchor.",
              },
              {
                term: "Keeps",
                detail: "A pinned copy of those boards and of each signed ballot client release.",
              },
              {
                term: "Serves",
                detail: "The boards to anyone who asks, so lookups work if our servers are down.",
              },
              {
                term: "Needs",
                detail:
                  "An always-on machine and an Ethereum RPC. Disk grows with the boards you pin.",
              },
            ].map(({ term, detail }) => (
              <div
                key={term}
                className="grid grid-cols-[6rem_1fr] gap-4 border-b border-border py-4 text-sm"
              >
                <dt className="font-medium">{term}</dt>
                <dd className="m-0 text-muted-foreground">{detail}</dd>
              </div>
            ))}
          </dl>
        </div>
        <p className="m-0 flex flex-wrap gap-x-8 gap-y-2">
          <a
            href="/receipt"
            className="inline-flex min-h-12 items-center gap-2 underline decoration-primary underline-offset-4"
          >
            Find your receipt <ArrowRight aria-hidden="true" className="size-4" />
          </a>
          <a
            href="/board"
            className="inline-flex min-h-12 items-center gap-2 underline decoration-primary underline-offset-4"
          >
            Read the board <ArrowRight aria-hidden="true" className="size-4" />
          </a>
        </p>
      </Section>
    </MockShell>
  );
}
