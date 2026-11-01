import { SectionMark } from "@abolishus/ui";
import type { ReactNode, Ref } from "react";

/**
 * A text link's focus: 3px and square in the ring's colour, as every box on
 * the page draws it. Left to the browser, a card's heading, its asker and the
 * lines under the boxes took a thin rounded outline that crossed the link's
 * own underline and a heading's descenders, a second focus style a keyboard
 * user met between the answers' rings (P2-29, the stream's iteration 33). An
 * outline 2px out, not a ring: a heading wrapped onto several lines gets one
 * shape round them all, clear of every line's underline, where a ring drew a
 * box per line, each over the underline of the line above.
 */
export const TEXT_FOCUS =
  "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** A page's opening: its eyebrow, its one `h1` and its lede. */
export function PageHeader({
  eyebrow,
  title,
  lede,
  titleId,
  titleRef,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  lede: ReactNode;
  titleId?: string;
  titleRef?: Ref<HTMLHeadingElement>;
  children?: ReactNode;
}) {
  return (
    <header className="grid gap-6 pt-2 md:pt-10">
      <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase">
        {eyebrow}
      </p>
      <h1
        id={titleId}
        ref={titleRef}
        tabIndex={titleRef === undefined ? undefined : -1}
        className="m-0 max-w-4xl font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance outline-none sm:text-6xl"
      >
        {title}
      </h1>
      <p className="m-0 max-w-prose text-lg text-pretty">{lede}</p>
      {children}
    </header>
  );
}

/**
 * A section of a page, on the register's ruled grid: numbered in the civic
 * record, and without `index` and `mark` in the everyday register, which
 * leaves its sections unnumbered (docs/design/language.md, Two registers).
 */
export function Section({
  index,
  mark,
  title,
  id,
  titleRef,
  lede,
  children,
}: {
  index?: string;
  mark?: string;
  title: string;
  id: string;
  titleRef?: Ref<HTMLHeadingElement>;
  lede?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="grid gap-8 border-t border-border pt-12 md:pt-16">
      <div className="grid gap-5 md:grid-cols-12">
        {index === undefined || mark === undefined ? null : (
          <SectionMark index={index} className="md:col-span-12">
            {mark}
          </SectionMark>
        )}
        <h2
          id={id}
          ref={titleRef}
          tabIndex={titleRef === undefined ? undefined : -1}
          className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight text-balance outline-none sm:text-4xl md:col-span-7"
        >
          {title}
        </h2>
        {lede === undefined ? null : (
          <div className="m-0 max-w-prose text-base text-pretty text-muted-foreground md:col-span-5 md:pt-2">
            {lede}
          </div>
        )}
      </div>
      {children}
    </section>
  );
}
