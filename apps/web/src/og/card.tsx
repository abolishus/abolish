// The link preview's layout, as satori draws it (flexbox only, inline
// styles), after the mockup in src/mockups/share-og-card.tsx: always the light
// palette, square corners, type sized to read at 300px wide in a chat.

import { fingerprintCells, FINGERPRINT_SIZE } from "@abolishus/ui";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import {
  type CivicPreview,
  type EverydayPreview,
  type PollPreview,
  type PreviewFormat,
  PREVIEW_SIZE,
  shortLink,
} from "./model.ts";
import { titles } from "../titles.ts";
import {
  answersCounted,
  answersSoFar,
  byline,
  closing,
  countingLines,
  countOf,
  dayOf,
  headline,
  longDayOf,
  openLines,
  sealedLines,
} from "./text.ts";

/** The light palette's tokens (packages/ui/src/styles.css) as sRGB. */
export const PALETTE = {
  background: "#ffffff",
  foreground: "#09090b",
  mutedForeground: "#71717a",
  muted: "#f4f4f5",
  border: "#e4e4e7",
  primary: "#007a55",
} as const;

const TYPE = {
  landscape: {
    pad: 64,
    byline: 30,
    question: 60,
    lines: 3,
    lead: 36,
    small: 26,
    bar: 20,
    foot: 28,
    seal: 64,
  },
  square: {
    pad: 80,
    byline: 36,
    question: 80,
    lines: 5,
    lead: 46,
    small: 32,
    bar: 28,
    foot: 34,
    seal: 88,
  },
} as const;

const row = (style: CSSProperties = {}): CSSProperties => ({ display: "flex", ...style });
const column = (style: CSSProperties = {}): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  ...style,
});

/** The poll's seal: its fingerprint, framed as packages/ui draws it. */
function Seal({ seal, size }: { seal: string; size: number }) {
  const shapes: ReactNode[] = [];
  fingerprintCells(seal).forEach((cells, y) =>
    cells.forEach((cell, x) => {
      const key = `${x}-${y}`;
      if (cell === "square")
        shapes.push(
          <rect
            key={key}
            x={x + 0.1}
            y={y + 0.1}
            width={0.8}
            height={0.8}
            fill={PALETTE.foreground}
          />,
        );
      else if (cell === "dot")
        shapes.push(
          <circle key={key} cx={x + 0.5} cy={y + 0.5} r={0.3} fill={PALETTE.foreground} />,
        );
      else if (cell === "corner") {
        // Mirrored with the cell, so the glyph stays symmetric.
        const outer = x < FINGERPRINT_SIZE / 2 ? x + 0.1 : x + 0.9;
        const inner = x < FINGERPRINT_SIZE / 2 ? x + 0.9 : x + 0.1;
        shapes.push(
          <polygon
            key={key}
            points={`${outer},${y + 0.1} ${inner},${y + 0.1} ${outer},${y + 0.9}`}
            fill={PALETTE.foreground}
          />,
        );
      }
    }),
  );
  return (
    <svg
      width={size}
      height={size}
      viewBox={`-0.5 -0.5 ${FINGERPRINT_SIZE + 1} ${FINGERPRINT_SIZE + 1}`}
      style={{ flexShrink: 0 }}
    >
      <rect
        x={-0.25}
        y={-0.25}
        width={FINGERPRINT_SIZE + 0.5}
        height={FINGERPRINT_SIZE + 0.5}
        fill="none"
        stroke={PALETTE.foreground}
        strokeWidth={0.08}
      />
      {shapes}
    </svg>
  );
}

/** A padlock with square corners, the size of the text beside it. */
function Lock({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path
        d="M4 11h16v11H4z M7 11V7a5 5 0 0 1 10 0v4"
        fill="none"
        stroke={PALETTE.foreground}
        strokeWidth={2.5}
      />
    </svg>
  );
}

function Bar({ share, height, color }: { share: number; height: number; color: string }) {
  return (
    <div style={row({ width: "100%", height, backgroundColor: PALETTE.muted })}>
      <div style={{ width: `${share * 100}%`, height, backgroundColor: color }} />
    </div>
  );
}

/** A state in two lines: what it is, then what follows from it. No result is ever one of them. */
function StateBlock({
  lines: [first, second],
  lock,
  t,
}: {
  lines: [string, string];
  lock: boolean;
  t: (typeof TYPE)[PreviewFormat];
}) {
  return (
    <div style={column({ gap: 8 })}>
      <div style={row({ alignItems: "center", gap: 16, fontSize: t.lead, fontWeight: 600 })}>
        {lock ? <Lock size={t.lead} /> : null}
        <span>{first}</span>
      </div>
      <div style={row({ fontSize: t.small, color: PALETTE.mutedForeground })}>{second}</div>
    </div>
  );
}

/** The block for results that carry nothing to show, or `undefined` for released ones. */
function unreleased(model: PollPreview, t: (typeof TYPE)[PreviewFormat]): ReactElement | undefined {
  switch (model.results.state) {
    case "sealed":
      return <StateBlock lines={sealedLines(model)} lock t={t} />;
    case "open":
      return <StateBlock lines={openLines(model)} lock={false} t={t} />;
    case "counting":
      return <StateBlock lines={countingLines(model)} lock={false} t={t} />;
    default:
      return undefined;
  }
}

function EverydayCard({ model, format }: { model: EverydayPreview; format: PreviewFormat }) {
  const t = TYPE[format];
  const { text } = titles(model.locale);
  const many = model.questionCount > 1;
  const results = model.results;
  let block: ReactElement;
  switch (results.state) {
    case "sealed":
    case "open":
    case "counting":
      block = unreleased(model, t)!;
      break;
    case "live":
    case "closed": {
      const tally =
        model.answers === undefined
          ? undefined
          : results.state === "closed"
            ? text("ogFinalCount", { answers: answersCounted(model, model.answers) })
            : text("ogUpdated", {
                answers: answersSoFar(model, model.answers),
                day: dayOf(model.locale, results.releasedAt),
              });
      block = (
        <div style={column({ gap: 12 })}>
          {many ? (
            <div style={row({ fontSize: t.small, color: PALETTE.mutedForeground })}>
              {text("ogQuestionOne", { count: model.questionCount })}
            </div>
          ) : null}
          <div style={row({ fontSize: t.lead, fontWeight: 600 })}>{results.lead.sentence}</div>
          <Bar share={results.lead.share} height={t.bar} color={PALETTE.primary} />
          {tally === undefined ? null : (
            <div style={row({ fontSize: t.small, color: PALETTE.mutedForeground })}>{tally}</div>
          )}
        </div>
      );
    }
  }
  const closes = closing(model);
  return (
    <div
      style={column({
        width: "100%",
        height: "100%",
        padding: t.pad,
        backgroundColor: PALETTE.background,
        color: PALETTE.foreground,
        fontFamily: "Oxanium",
      })}
    >
      <div
        style={row({
          alignItems: "flex-start",
          gap: 16,
          fontSize: t.byline,
          color: PALETTE.mutedForeground,
        })}
      >
        <div style={row({ flex: 1 })}>{byline(model)}</div>
        {many ? (
          <div
            style={row({
              flexShrink: 0,
              padding: "0 20px",
              border: `2px solid ${PALETTE.border}`,
              color: PALETTE.foreground,
            })}
          >
            {text("ogQuestions", { count: model.questionCount })}
          </div>
        ) : null}
      </div>
      <div
        style={{
          display: "block",
          marginTop: 24,
          fontSize: t.question,
          fontWeight: 600,
          lineHeight: format === "square" ? 1.06 : 1.08,
          letterSpacing: -0.01 * t.question,
          lineClamp: t.lines,
        }}
      >
        {headline(model)}
      </div>
      <div style={row({ flex: 1 })} />
      {block}
      <div
        style={row({
          alignItems: "center",
          gap: 20,
          marginTop: 32,
          paddingTop: 24,
          borderTop: `2px solid ${PALETTE.border}`,
          fontSize: t.foot,
        })}
      >
        <Seal seal={model.seal} size={t.seal} />
        <div style={row({ flex: 1, fontWeight: 600 })}>{shortLink(model)}</div>
        {closes === undefined ? null : (
          <div style={row({ flexShrink: 0, color: PALETTE.mutedForeground })}>{closes}</div>
        )}
      </div>
    </div>
  );
}

function CivicCard({ model, format }: { model: CivicPreview; format: PreviewFormat }) {
  const square = format === "square";
  const { text } = titles(model.locale);
  const label: CSSProperties = {
    display: "flex",
    fontFamily: "JetBrains Mono",
    fontSize: square ? 26 : 20,
    letterSpacing: square ? 4 : 3,
    textTransform: "uppercase",
  };
  const results = model.results;
  let body: ReactElement;
  switch (results.state) {
    case "sealed":
    case "open":
    case "counting":
      body = (
        <div style={column({ marginTop: square ? 40 : 20 })}>{unreleased(model, TYPE[format])}</div>
      );
      break;
    case "live":
    case "closed":
      body = (
        <div
          style={column({
            marginTop: square ? 40 : 20,
            borderTop: `2px solid ${PALETTE.foreground}`,
          })}
        >
          {results.tiers.map((tier) => (
            <div
              key={tier.name}
              style={column({
                gap: square ? 16 : 8,
                padding: square ? "28px 0" : "12px 0",
                borderBottom: `1px solid ${PALETTE.border}`,
              })}
            >
              <div style={row({ alignItems: "baseline", gap: 24 })}>
                <div
                  style={row({
                    flex: 1,
                    alignItems: "baseline",
                    gap: 12,
                    fontSize: square ? 36 : 28,
                  })}
                >
                  <span>{tier.name}</span>
                  <span style={{ fontFamily: "JetBrains Mono", color: PALETTE.mutedForeground }}>
                    {countOf(model.locale, tier.ballots)}
                  </span>
                </div>
                <div style={row({ fontSize: square ? 44 : 34, fontWeight: 600 })}>
                  {tier.result}
                </div>
              </div>
              <Bar share={tier.share} height={square ? 16 : 10} color={PALETTE.foreground} />
            </div>
          ))}
        </div>
      );
  }
  const scope =
    results.state === "closed"
      ? text("ogTiers")
      : results.state === "live"
        ? text("ogTiersReleased", { day: longDayOf(model.locale, results.releasedAt) })
        : text("ogTiersWill");
  return (
    <div
      style={column({
        width: "100%",
        height: "100%",
        padding: square ? 80 : "48px 64px",
        backgroundColor: PALETTE.background,
        color: PALETTE.foreground,
        fontFamily: "Oxanium",
      })}
    >
      <div style={row({ alignItems: "flex-start", justifyContent: "space-between", gap: 24 })}>
        <div style={column({ flex: 1, gap: 12 })}>
          <div style={label}>{text("ogCivic", { kind: model.kind })}</div>
          <div
            style={{
              display: "block",
              fontSize: square ? 72 : 60,
              fontWeight: 600,
              lineHeight: 1.05,
              lineClamp: square ? 4 : 2,
            }}
          >
            {headline(model)}
          </div>
        </div>
        <Seal seal={model.seal} size={square ? 96 : 76} />
      </div>
      <div
        style={row({ marginTop: 16, fontSize: square ? 34 : 26, color: PALETTE.mutedForeground })}
      >
        {scope}
      </div>
      {body}
      <div style={row({ flex: 1 })} />
      <div
        style={row({
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 24,
          paddingTop: square ? 32 : 16,
        })}
      >
        <div style={row({ fontFamily: "JetBrains Mono", fontSize: square ? 32 : 26 })}>
          {shortLink(model)}
        </div>
        <div style={label}>{text("ogRecount")}</div>
      </div>
    </div>
  );
}

/** The card for `model` in `format`, as an element tree for satori. */
export function PreviewCard({ model, format }: { model: PollPreview; format: PreviewFormat }) {
  const { width, height } = PREVIEW_SIZE[format];
  return (
    <div style={row({ width, height })}>
      {model.civic ? (
        <CivicCard model={model} format={format} />
      ) : (
        <EverydayCard model={model} format={format} />
      )}
    </div>
  );
}
