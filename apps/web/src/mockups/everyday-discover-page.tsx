import { buttonVariants, cn } from "@abolishus/ui";
import { ToggleGroup, ToggleGroupItem } from "@abolishus/ui/ui/toggle-group";
import { useId, useState } from "react";

import { PLACES, TOPICS } from "./everyday-data.ts";
import { STREAM } from "./everyday-fixtures.ts";
import { EverydayShell, Frame, ROUND } from "./everyday-parts.tsx";
import { StreamCard } from "./everyday-stream.tsx";

const CHIP =
  "h-12 px-4 text-sm font-normal aria-pressed:bg-foreground aria-pressed:text-background";

function Filter({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const labelId = useId();
  return (
    <div className="grid gap-2">
      <span id={labelId} className="text-sm text-muted-foreground">
        {label}
      </span>
      <ToggleGroup
        variant="outline"
        aria-labelledby={labelId}
        value={value === null ? [] : [value]}
        onValueChange={(next) => onChange((next as string[])[0] ?? null)}
        className="w-full flex-wrap"
      >
        {options.map((option) => (
          <ToggleGroupItem key={option} value={option} className={CHIP}>
            {option}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

export function DiscoverPage({
  topic: initialTopic = null,
}: {
  /** Start with a topic picked, as from a topic link. */
  topic?: string | null;
}) {
  const [topic, setTopic] = useState<string | null>(initialTopic);
  const [place, setPlace] = useState<string | null>(null);
  const shown = STREAM.filter(
    (s) => (topic === null || s.topic === topic) && (place === null || s.place === place),
  );
  const filtered = topic !== null || place !== null;
  return (
    <EverydayShell current="/discover">
      <Frame className="grid gap-6 pt-12 pb-10 md:pt-20">
        <h1 className="m-0 max-w-4xl font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
          What people are asking
        </h1>
        <p className="m-0 max-w-prose text-lg text-pretty">
          Questions from neighbours, groups and schools. Answer any of them in a tap or two. Newest
          first; nothing here is ranked by how many clicks or arguments it gets.
        </p>
      </Frame>
      <Frame className="grid gap-10 lg:grid-cols-12 lg:gap-x-10">
        <section
          aria-labelledby="filters-title"
          className="grid content-start gap-6 lg:sticky lg:top-6 lg:col-span-4 lg:self-start"
        >
          <h2 id="filters-title" className="m-0 font-heading text-xl font-semibold">
            Narrow it down
          </h2>
          <Filter label="Topic" options={TOPICS} value={topic} onChange={setTopic} />
          <Filter label="Place" options={PLACES} value={place} onChange={setPlace} />
          <p className="m-0 text-sm text-muted-foreground" aria-live="polite">
            {shown.length === 1 ? "1 question" : `${shown.length} questions`}
            {filtered ? " match" : ""}
          </p>
          {filtered ? (
            <button
              type="button"
              onClick={() => {
                setTopic(null);
                setPlace(null);
              }}
              className={cn(buttonVariants({ variant: "outline" }), ROUND, "justify-self-start")}
            >
              Show everything
            </button>
          ) : null}
        </section>
        <section aria-labelledby="stream-title" className="grid content-start gap-6 lg:col-span-8">
          <h2 id="stream-title" className="sr-only">
            Questions
          </h2>
          {shown.length === 0 ? (
            <div className="grid gap-2 border border-dashed border-border p-8">
              <p className="m-0 font-heading text-xl font-semibold">Nothing here yet</p>
              <p className="m-0 text-base text-muted-foreground">
                No open questions match both filters. Try one of them on its own, or ask the first
                one.
              </p>
            </div>
          ) : (
            <ol className="m-0 grid list-none gap-6 p-0">
              {shown.map((item) => (
                <li key={item.id}>
                  <StreamCard item={item} />
                </li>
              ))}
            </ol>
          )}
          <nav aria-label="More questions" className="grid gap-2 border-t border-border pt-6">
            <p className="m-0 text-base">That’s the newest {STREAM.length}.</p>
            <a
              href="/discover?page=2"
              className={cn(buttonVariants({ variant: "outline" }), ROUND, "justify-self-start")}
            >
              Show older questions
            </a>
          </nav>
        </section>
      </Frame>
    </EverydayShell>
  );
}
