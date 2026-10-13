import { Check, Clock, Diamond, X } from "lucide-react";
import { cn } from "cn";
import { useId, type ReactNode } from "react";

import { useI18n } from "../i18n/context.tsx";
import { formatMessage, type Message } from "../i18n/format.ts";
import { auditPath, type AuditStep, type EntryRange } from "../lib/board-tree.ts";
import { Fingerprint } from "./fingerprint.tsx";

/** One hash of the audit path, as the proof gives it. */
export interface InclusionSibling {
  /** Which side of the running hash it goes on: "left" is `node(hash, r)`. */
  side: "left" | "right";
  /** 64 lowercase hex digits. */
  hash: string;
}

/** The checkpoint the path is checked against, and where it is on Ethereum. */
export interface InclusionAnchor {
  /** The checkpoint's root: 64 lowercase hex digits. */
  root: string;
  /** The checkpoint's size; an inclusion proof binds a size only together with its root. */
  size: number;
  /** What it is, translated ("Checkpoint anchored 3 Nov 2026, 15:00 UTC"). */
  title: string;
  /** Its facts in order, translated: segment, Ethereum block, transaction. */
  facts: readonly { label: string; value: string; evidence?: boolean }[];
}

/**
 * The verifier's verdict. `verified`: the computed root is the anchored one.
 * `mismatch`: it isn't. `pending`: it is the root the reader's receipt holds,
 * and the checkpoint isn't anchored yet.
 */
export type InclusionVerdict = "verified" | "mismatch" | "pending";

export interface InclusionPathLabels {
  /** The figure's caption, with the entry and the tree's size. */
  caption: string;
  /** The leaf ("Your entry"). */
  leaf: string;
  /** Names for the two hashes of the leaf: the entry's hash and its leaf hash `MTH({entry_hash})`. */
  entryHash: string;
  leafHash: string;
  /** A step's heading, with `{step}` and `{total}` placeholders. */
  step: Message;
  /** A hash the proof gives ("From the proof") and one the verifier computes ("Computed"). */
  given: string;
  computed: string;
  /** A run of entries: `{from}` and `{to}`, both included ("entries {from}–{to}"). */
  range: Message;
  /** A single entry: `{index}`. */
  single: Message;
  /** How many entries a hash commits to: a plural on `{count}`. */
  count: Message;
  /** The computed root: `{size}` ("Root of all {size} entries"). */
  root: Message;
  /** The anchored root, beside the computed one. */
  anchoredRoot: string;
  verdict: Record<InclusionVerdict, string>;
  /** A fingerprint's name: `{what}` and `{hash}` (its first 8 digits). */
  fingerprint: Message;
  /** The compact drawing's name: `{count}` steps and `{size}` entries. */
  levels: Message;
  /** The disclosure listing every hash in full. */
  full: string;
  /** Side words for that list. */
  sides: { left: string; right: string };
}

export interface InclusionPathProps {
  /** The entry's index `i` and the size `n` of the tree the proof is for. */
  index: number;
  size: number;
  /** `entry_hash_i`, and the leaf hash `MTH({entry_hash_i})` the path starts from. */
  entryHash: string;
  leafHash: string;
  /** The audit path `PATH(i, D[n])`, in order, with the side each hash goes on. */
  siblings: readonly InclusionSibling[];
  /** The running hash after each step, as the verifier computed it. */
  parents: readonly string[];
  /** The root the path computes: the last of `parents` (the leaf hash for a tree of one). */
  root: string;
  anchor: InclusionAnchor;
  verdict: InclusionVerdict;
  labels: InclusionPathLabels;
  /** `full` draws every step with its hashes; `compact` draws the path's shape for a scene. */
  variant?: "full" | "compact";
  className?: string;
}

const HEX = /^[0-9a-f]{64}$/;
const short = (hash: string) => hash.slice(0, 8);

function check(props: InclusionPathProps, steps: AuditStep[]) {
  const { siblings, parents, root, leafHash, entryHash, anchor, verdict, size } = props;
  for (const hash of [
    root,
    leafHash,
    entryHash,
    anchor.root,
    ...parents,
    ...siblings.map((s) => s.hash),
  ])
    if (!HEX.test(hash)) throw new RangeError("hashes are 64 lowercase hex digits");
  if (siblings.length !== steps.length || parents.length !== steps.length)
    throw new RangeError("a path has one hash, and one computed parent, per level of its tree");
  steps.forEach((step, i) => {
    if (siblings[i]!.side !== step.side)
      throw new RangeError(`hash ${i} of the path is on the wrong side for entry ${props.index}`);
  });
  if (root !== (parents.at(-1) ?? leafHash))
    throw new RangeError("the root is the path's last computed hash");
  if (anchor.size !== size)
    throw new RangeError("an inclusion proof is checked against the root of its own size");
  const matches = root === anchor.root;
  if ((verdict === "mismatch") === matches)
    throw new RangeError(`a ${verdict} verdict with roots that ${matches ? "match" : "differ"}`);
}

function Ruler({
  size,
  mine,
  given,
  compact = false,
}: {
  size: number;
  mine: EntryRange;
  given?: EntryRange;
  compact?: boolean;
}) {
  const span = (r: EntryRange) => ({
    left: `${(r.from / size) * 100}%`,
    width: `max(2px, ${((r.to - r.from) / size) * 100}%)`,
  });
  return (
    <span
      aria-hidden="true"
      className={cn("relative block w-full bg-muted", compact ? "h-1.5" : "h-1")}
    >
      {given === undefined ? null : (
        <span className="absolute inset-y-0 bg-foreground/45" style={span(given)} />
      )}
      <span className="absolute inset-y-0 bg-primary" style={span(mine)} />
    </span>
  );
}

function Node({
  title,
  hash,
  detail,
  count,
  fingerprint,
  tone,
}: {
  title: string;
  hash: string;
  detail: string;
  count?: string;
  fingerprint: string;
  tone: "mine" | "given";
}) {
  return (
    <div
      className={cn(
        "grid min-w-0 content-start gap-1 p-2",
        tone === "mine" ? "border-2 border-primary" : "border border-dashed border-foreground/40",
      )}
    >
      <span className="truncate text-xs text-muted-foreground">{title}</span>
      <span className="flex min-w-0 items-center gap-2">
        <Fingerprint value={hash} label={fingerprint} size={20} />
        <code translate="no" className="font-mono text-xs">
          {short(hash)}…
        </code>
      </span>
      <span className="font-mono text-xs break-words">{detail}</span>
      {count === undefined ? null : <span className="text-xs text-muted-foreground">{count}</span>}
    </div>
  );
}

/** Lines from a level's two hashes down to the node they make. */
function Connector({
  mine,
  to,
}: {
  mine: "left" | "right" | "centre";
  to: "left" | "right" | "centre";
}) {
  const x = { left: 25, right: 75, centre: 50 } as const;
  const given = mine === "left" ? "right" : mine === "right" ? "left" : undefined;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 20"
      preserveAspectRatio="none"
      className="block h-5 w-full overflow-visible"
    >
      {given === undefined ? null : (
        <line
          x1={x[given]}
          y1={0}
          x2={x[to]}
          y2={20}
          vectorEffect="non-scaling-stroke"
          className="stroke-foreground/40"
          strokeDasharray="3 3"
        />
      )}
      <line
        x1={x[mine]}
        y1={0}
        x2={x[to]}
        y2={20}
        vectorEffect="non-scaling-stroke"
        className="stroke-primary"
        strokeWidth={2}
      />
    </svg>
  );
}

/**
 * "Your place, proven": the Merkle inclusion path of one board entry
 * (docs/spec/board.md, Inclusion proofs), drawn exactly. Each step pairs the
 * running hash with the proof's hash on its side, and a ruler under the step
 * shows the run of entries each commits to, so the rest of the tree is there
 * as the spans it covers. The path ends at the root, set against the
 * checkpoint anchored on Ethereum.
 *
 * It verifies nothing. It draws what a verifier hands it, and refuses a path
 * that doesn't fit its tree or a verdict its own roots contradict.
 */
export function InclusionPath(props: InclusionPathProps) {
  const {
    index,
    size,
    entryHash,
    leafHash,
    siblings,
    parents,
    root,
    anchor,
    verdict,
    labels,
    variant = "full",
    className,
  } = props;
  const steps = auditPath(index, size);
  check(props, steps);
  const { locale } = useI18n();
  const captionId = useId();
  const f = (message: Message, params: Record<string, string | number> = {}) =>
    formatMessage(locale, message, params);
  const rangeText = (r: EntryRange) =>
    r.to - r.from === 1
      ? f(labels.single, { index: r.from })
      : f(labels.range, { from: r.from, to: r.to - 1 });
  const fp = (what: string, hash: string) => f(labels.fingerprint, { what, hash: short(hash) });
  const leafRange = { from: index, to: index + 1 };
  const running = (i: number) => (i === 0 ? leafRange : steps[i - 1]!.parent);
  const runningHash = (i: number) => (i === 0 ? leafHash : parents[i - 1]!);
  const rootTitle = f(labels.root, { size });

  const verdictBox = (
    <Verdict
      verdict={verdict}
      anchor={anchor}
      root={root}
      labels={labels}
      rootTitle={rootTitle}
      fp={fp}
      compact={variant === "compact"}
    />
  );

  if (variant === "compact") {
    return (
      <figure
        data-slot="inclusion-path"
        data-verdict={verdict}
        aria-labelledby={captionId}
        className={cn("m-0 grid min-w-0 gap-3", className)}
      >
        <figcaption
          id={captionId}
          className="font-mono text-xs tracking-wide text-muted-foreground uppercase"
        >
          {labels.caption}
        </figcaption>
        <p className="m-0 flex min-w-0 items-center gap-3 text-sm">
          <Fingerprint value={entryHash} label={fp(labels.leaf, entryHash)} size={28} />
          <span className="min-w-0">
            <span className="block font-medium">{labels.leaf}</span>
            <span className="block font-mono text-xs text-muted-foreground">
              {rangeText(leafRange)}
            </span>
          </span>
        </p>
        <span
          role="img"
          aria-label={f(labels.levels, { count: steps.length, size })}
          className="grid gap-1 border-s-2 border-primary ps-3"
        >
          {steps.map((step, i) => (
            <Ruler key={i} compact size={size} mine={running(i)} given={step.sibling} />
          ))}
          <Ruler compact size={size} mine={{ from: 0, to: size }} />
        </span>
        <p className="m-0 flex min-w-0 items-center gap-3 text-sm">
          <Fingerprint value={root} label={fp(rootTitle, root)} size={28} />
          <span className="min-w-0">
            <span className="block font-medium">{rootTitle}</span>
            <code translate="no" className="block font-mono text-xs text-muted-foreground">
              {short(root)}…
            </code>
          </span>
        </p>
        {verdictBox}
      </figure>
    );
  }

  const sideOfMine = (i: number) => (steps[i]!.side === "left" ? "right" : "left");
  return (
    <figure
      data-slot="inclusion-path"
      data-verdict={verdict}
      aria-labelledby={captionId}
      className={cn("m-0 grid max-w-3xl min-w-0 gap-4", className)}
    >
      <figcaption
        id={captionId}
        className="font-mono text-xs tracking-wide text-muted-foreground uppercase"
      >
        {labels.caption}
      </figcaption>
      <ol className="m-0 grid min-w-0 list-none p-0">
        <li className="grid gap-2">
          <div className="grid min-w-0 gap-2 border-2 border-primary p-3 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-4">
            <Fingerprint value={entryHash} label={fp(labels.leaf, entryHash)} size={44} />
            <div className="grid min-w-0 gap-1">
              <span className="font-medium">
                {labels.leaf} · <span className="font-mono">{rangeText(leafRange)}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {labels.entryHash}{" "}
                <code translate="no" className="font-mono text-foreground">
                  {short(entryHash)}…
                </code>{" "}
                · {labels.leafHash}{" "}
                <code translate="no" className="font-mono text-foreground">
                  {short(leafHash)}…
                </code>
              </span>
            </div>
          </div>
          <Connector mine="centre" to={steps.length === 0 ? "centre" : sideOfMine(0)} />
        </li>
        {steps.map((step, i) => {
          const mine = sideOfMine(i);
          const next = i + 1 < steps.length ? sideOfMine(i + 1) : "centre";
          const mineNode = (
            <Node
              key="mine"
              tone="mine"
              title={labels.computed}
              hash={runningHash(i)}
              detail={rangeText(running(i))}
              fingerprint={fp(labels.computed, runningHash(i))}
            />
          );
          const givenNode = (
            <Node
              key="given"
              tone="given"
              title={labels.given}
              hash={siblings[i]!.hash}
              detail={rangeText(step.sibling)}
              count={f(labels.count, { count: step.sibling.to - step.sibling.from })}
              fingerprint={fp(labels.given, siblings[i]!.hash)}
            />
          );
          return (
            <li key={i} className="grid min-w-0 gap-2" data-side={step.side}>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="font-mono tracking-wide text-muted-foreground uppercase">
                  {f(labels.step, { step: i + 1, total: steps.length })}
                </span>
                <span className="text-end text-muted-foreground">
                  {f(labels.count, { count: step.parent.to - step.parent.from })}
                </span>
              </div>
              <Ruler size={size} mine={running(i)} given={step.sibling} />
              <div className="grid min-w-0 grid-cols-2 gap-2">
                {mine === "left" ? [mineNode, givenNode] : [givenNode, mineNode]}
              </div>
              <Connector mine={mine} to={next} />
            </li>
          );
        })}
        <li className="grid gap-2">
          <Ruler size={size} mine={{ from: 0, to: size }} />
          <div className="grid min-w-0 gap-2 border-2 border-primary p-3 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-4">
            <Fingerprint value={root} label={fp(rootTitle, root)} size={44} />
            <div className="grid min-w-0 gap-1">
              <span className="font-medium">{rootTitle}</span>
              <code translate="no" className="font-mono text-xs break-all">
                {root}
              </code>
            </div>
          </div>
        </li>
      </ol>
      {verdictBox}
      <details className="border-y border-border">
        <summary className="flex min-h-12 cursor-pointer items-center text-sm font-medium">
          {labels.full}
        </summary>
        <ol className="m-0 mb-4 grid list-none gap-2 p-0 font-mono text-xs">
          {siblings.map((s, i) => (
            <li key={i} className="grid gap-0.5 border-b border-border pb-2">
              <span className="text-muted-foreground">
                {f(labels.step, { step: i + 1, total: steps.length })} · {labels.sides[s.side]} ·{" "}
                {rangeText(steps[i]!.sibling)}
              </span>
              <code translate="no" className="break-all">
                {s.hash}
              </code>
            </li>
          ))}
        </ol>
      </details>
    </figure>
  );
}

function Verdict({
  verdict,
  anchor,
  root,
  labels,
  rootTitle,
  fp,
  compact,
}: {
  verdict: InclusionVerdict;
  anchor: InclusionAnchor;
  root: string;
  labels: InclusionPathLabels;
  rootTitle: string;
  fp: (what: string, hash: string) => string;
  compact: boolean;
}) {
  const Icon = { verified: Check, mismatch: X, pending: Clock }[verdict];
  const roots: { title: string; hash: string }[] = compact
    ? [{ title: labels.anchoredRoot, hash: anchor.root }]
    : [
        { title: rootTitle, hash: root },
        { title: labels.anchoredRoot, hash: anchor.root },
      ];
  const row = (title: string, hash: string): ReactNode => (
    <div key={title} className="flex min-w-0 items-center gap-3">
      <Fingerprint value={hash} label={fp(title, hash)} size={compact ? 24 : 32} />
      <span className="grid min-w-0">
        <span className="text-xs text-muted-foreground">{title}</span>
        <code translate="no" className="truncate font-mono text-xs">
          {short(hash)}…{hash.slice(-8)}
        </code>
      </span>
    </div>
  );
  return (
    <div
      role="group"
      aria-label={anchor.title}
      data-verdict={verdict}
      className={cn(
        "grid min-w-0 gap-3 border-2 p-3 sm:p-4",
        verdict === "verified" && "border-recorded",
        verdict === "mismatch" && "border-destructive",
        verdict === "pending" && "border-pending",
      )}
    >
      <p className="m-0 flex items-start gap-2 text-sm font-medium">
        <Icon
          aria-hidden="true"
          className={cn(
            "mt-0.5 size-4 shrink-0",
            verdict === "verified" && "text-recorded",
            verdict === "mismatch" && "text-destructive",
            verdict === "pending" && "text-pending",
          )}
        />
        <span>{labels.verdict[verdict]}</span>
      </p>
      <div className={cn("grid min-w-0 gap-3", !compact && "sm:grid-cols-2")}>
        {roots.map((r) => row(r.title, r.hash))}
      </div>
      <div className="grid min-w-0 gap-2 border-t border-border pt-3">
        <p className="m-0 flex items-center gap-2 text-sm">
          <Diamond aria-hidden="true" className="size-4 shrink-0" />
          {anchor.title}
        </p>
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
          {anchor.facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className={cn("m-0 min-w-0", fact.evidence && "font-mono break-all")}>
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
