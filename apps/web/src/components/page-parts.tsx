import { SectionMark } from "@abolishus/ui";
import type { ReactNode, Ref } from "react";

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
  title: string;
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

/** A numbered section of a page, on the register's ruled grid. */
export function Section({
  index,
  mark,
  title,
  id,
  titleRef,
  lede,
  children,
}: {
  index: string;
  mark: string;
  title: string;
  id: string;
  titleRef?: Ref<HTMLHeadingElement>;
  lede?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="grid gap-8 border-t border-border pt-12 md:pt-16">
      <div className="grid gap-5 md:grid-cols-12">
        <SectionMark index={index} className="md:col-span-12">
          {mark}
        </SectionMark>
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
