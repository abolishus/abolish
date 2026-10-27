import { useTranslate } from "@abolishus/ui";

import { catalogs, type Messages } from "../messages.ts";
import { PageHeader, Section } from "./page-parts.tsx";

type Key = keyof Messages;

// Every claim here is checked against docs/spec/verifier.md, the verifier's
// command line (packages/verifier/src/cli.ts) and the community node
// (apps/node/README.md) as they stand (docs/status/P2-19.md, part 11). What
// isn't built yet, the anchor above all, is said plainly rather than shown
// with a sample run, as the mockup's recorded run was.

/**
 * The commands, run from a checkout: the verifier installs no binary yet
 * (packages/verifier/README.md), and the node is source-only. The `$` names
 * are the values `RUN_VALUES` explains, so the commands need no translation.
 */
export const COMMANDS = [
  {
    title: "recountStep1Title",
    body: "recountStep1Body",
    command: "git clone https://github.com/abolishus/abolish\ncd abolish\nvp install",
  },
  {
    title: "recountStep2Title",
    body: "recountStep2Body",
    command:
      "vp run --filter @abolishus/node start -- fetch --blocks boards \\\n  --l1 $L1_NODE --anchor $ANCHOR --gateway $GATEWAY",
  },
  {
    title: "recountStep3Title",
    body: "recountStep3Body",
    command:
      "vp run --filter @abolishus/node start -- verify --blocks boards --reports reports \\\n  --l1 $L1_NODE --anchor $ANCHOR --l2 $L2_NODE --registry $REGISTRY",
  },
  {
    title: "recountStep4Title",
    body: "recountStep4Body",
    command: "vp node packages/verifier/src/bin.ts --gateway $GATEWAY reports/$POLL_ID",
  },
] as const satisfies readonly { title: Key; body: Key; command: string }[];

const RUN_VALUES = [
  { name: "$L1_NODE", text: "recountValueL1" },
  { name: "$L2_NODE", text: "recountValueL2" },
  { name: "$GATEWAY", text: "recountValueGateway" },
  { name: "$ANCHOR", text: "recountValueAnchor" },
  { name: "$REGISTRY", text: "recountValueRegistry" },
  { name: "$POLL_ID", text: "recountValuePoll" },
] as const satisfies readonly { name: string; text: Key }[];

/** The verifier's exit codes (docs/spec/verifier.md, Command line); a test ties them to `EXIT_CODES`. */
export const EXIT_ROWS = [
  { code: 0, verdict: "recountExit0", meaning: "recountExit0Means" },
  { code: 20, verdict: "recountExit20", meaning: "recountExit20Means" },
  { code: 21, verdict: "recountExit21", meaning: "recountExit21Means" },
  { code: 22, verdict: "recountExit22", meaning: "recountExit22Means" },
  { code: 64, verdict: "recountExit64", meaning: "recountExit64Means" },
] as const satisfies readonly { code: number; verdict: Key; meaning: Key }[];

/** The specification's groups of checks, by number; a test ties them to its headings. */
export const CHECK_GROUPS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

const TRUSTED = ["Servers", "L1", "L2", "Gateways"] as const;

const SECTIONS = [
  { id: "run", mark: "recountRunMark" },
  { id: "checks", mark: "recountChecksMark" },
  { id: "trust", mark: "recountTrustMark" },
] as const satisfies readonly { id: string; mark: Key }[];

const pad2 = (n: number) => String(n).padStart(2, "0");

function Contents() {
  const t = useTranslate(catalogs);
  return (
    <nav aria-label={t("howContents")} className="border-t-2 border-foreground pt-4">
      <ol className="m-0 grid list-none gap-x-6 p-0 sm:grid-cols-3">
        {SECTIONS.map((s, i) => (
          <li key={s.id} className="border-b border-border">
            <a
              href={`#${s.id}`}
              className="flex min-h-12 items-baseline gap-3 py-3 text-sm underline-offset-4 hover:underline"
            >
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {pad2(i + 1)}
              </span>
              {t(s.mark)}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Run() {
  const t = useTranslate(catalogs);
  return (
    <Section
      id="run"
      index="01"
      mark={t("recountRunMark")}
      title={t("recountRunTitle")}
      lede={t("recountRunLede")}
    >
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-x-6">
        <ol className="m-0 grid min-w-0 list-none content-start gap-8 p-0 lg:col-span-7">
          {COMMANDS.map((step, i) => (
            <li key={step.title} className="grid min-w-0 gap-3">
              <h3 className="m-0 flex items-baseline gap-3 font-heading text-lg font-semibold">
                <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
                  {pad2(i + 1)}
                </span>
                {t(step.title)}
              </h3>
              <p className="m-0 max-w-prose text-base text-pretty">{t(step.body)}</p>
              {/* Wraps rather than scrolls, so at 360px and with spaced text
                  nothing is hidden or drawn over the column beside it. */}
              <pre className="m-0 border border-foreground bg-muted p-4 font-mono text-sm whitespace-pre-wrap wrap-anywhere">
                <code translate="no">{step.command}</code>
              </pre>
            </li>
          ))}
        </ol>
        <div className="grid min-w-0 content-start gap-10 lg:col-span-5">
          <dl className="m-0 grid border-t border-foreground">
            {RUN_VALUES.map((v) => (
              <div key={v.name} className="grid gap-1 border-b border-border py-3 text-sm">
                <dt>
                  <code translate="no" className="font-mono">
                    {v.name}
                  </code>
                </dt>
                <dd className="m-0 text-muted-foreground">{t(v.text)}</dd>
              </div>
            ))}
          </dl>
          <table className="w-full border-collapse text-sm">
            <caption className="pb-3 text-start font-mono text-xs tracking-wide text-muted-foreground uppercase">
              {t("recountExitCaption")}
            </caption>
            <thead>
              <tr className="border-y border-foreground">
                <th scope="col" className="py-2 pe-4 text-start font-medium">
                  {t("recountExitCode")}
                </th>
                <th scope="col" className="py-2 text-start font-medium">
                  {t("recountExitVerdict")}
                </th>
              </tr>
            </thead>
            <tbody>
              {EXIT_ROWS.map((row) => (
                <tr key={row.code} className="border-b border-border align-top">
                  <td className="py-3 pe-4 font-mono tabular-nums">{row.code}</td>
                  <td className="py-3">
                    <span className="block font-medium">{t(row.verdict)}</span>
                    <span className="block text-muted-foreground">{t(row.meaning)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="m-0 text-sm text-muted-foreground">{t("recountExitOther")}</p>
        </div>
      </div>
    </Section>
  );
}

function Checks() {
  const t = useTranslate(catalogs);
  return (
    <Section
      id="checks"
      index="02"
      mark={t("recountChecksMark")}
      title={t("recountChecksTitle", { count: CHECK_GROUPS.length })}
      lede={t("recountChecksLede")}
    >
      <ol className="m-0 grid list-none border-t-2 border-foreground p-0 md:grid-cols-2 md:gap-x-6">
        {CHECK_GROUPS.map((n) => (
          <li key={n} className="grid content-start gap-2 border-b border-border py-6">
            <h3 className="m-0 flex gap-3 font-heading text-xl leading-snug font-semibold">
              <span className="font-mono text-sm font-normal text-muted-foreground tabular-nums">
                {n}
              </span>
              {t(`recountCheck${n}Title`)}
            </h3>
            <p className="m-0 text-base text-pretty">{t(`recountCheck${n}Body`)}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Trust() {
  const t = useTranslate(catalogs);
  return (
    <Section
      id="trust"
      index="03"
      mark={t("recountTrustMark")}
      title={t("recountTrustTitle")}
      lede={t("recountTrustLede")}
    >
      <dl className="m-0 grid border-t-2 border-foreground">
        {TRUSTED.map((id) => (
          <div
            key={id}
            className="grid gap-2 border-b border-border py-5 md:grid-cols-12 md:gap-x-6"
          >
            <dt className="font-heading text-lg font-semibold md:col-span-4">
              {t(`recountTrust${id}`)}
            </dt>
            <dd className="m-0 text-base text-pretty md:col-span-8">
              {t(`recountTrust${id}Means`)}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

/** `/verify`: how to count a poll again without us, and what that run trusts. */
export function VerifyPage() {
  const t = useTranslate(catalogs);
  return (
    <div className="grid gap-16">
      <PageHeader eyebrow={t("recountEyebrow")} title={t("recountTitle")} lede={t("recountLede")}>
        <aside
          aria-labelledby="not-yet"
          className="grid max-w-prose gap-2 border-s-4 border-pending bg-muted p-4"
        >
          <h2 id="not-yet" className="m-0 font-heading text-lg font-semibold">
            {t("recountNotYetTitle")}
          </h2>
          <p className="m-0 text-base text-pretty">{t("recountNotYetBody")}</p>
        </aside>
        <Contents />
      </PageHeader>
      <Run />
      <Checks />
      <Trust />
      {/* Text, not a link: pages link only to this site (tests/ssr.test.ts). */}
      <p className="m-0 max-w-prose border-t border-border pt-16 text-lg text-pretty">
        {t("recountSource")}
      </p>
    </div>
  );
}
