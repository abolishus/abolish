import { Button, Count, Fingerprint } from "@abolishus/ui";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader } from "@abolishus/ui/ui/empty";
import { Input } from "@abolishus/ui/ui/input";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
} from "@abolishus/ui/ui/pagination";
import { ToggleGroup, ToggleGroupItem } from "@abolishus/ui/ui/toggle-group";
import { ArrowRight, CircleCheckBig, CircleDot, Clock, Search } from "lucide-react";
import { useId, useState } from "react";

import { AS_OF, sampleHash } from "./board-data.ts";

import { Micro, Section } from "./board-parts.tsx";
import { LEVY, TRANSIT } from "./fixtures.ts";
import {
  LISTED_TOTAL,
  REGISTER,
  REGISTER_PAGES,
  type PollKind,
  type PollMethod,
  type PollStatus,
  type RegisterRow,
} from "./polls-index-data.ts";
import { MockShell, PageHead } from "./shell.tsx";

const WESTBROOK_ID = sampleHash("westbrook-school-start-times");
const STATUSES: readonly PollStatus[] = ["Open", "Scheduled", "Closed"];
const KINDS: readonly PollKind[] = ["Referendum", "Organisational vote", "Open poll"];
const METHODS: readonly PollMethod[] = ["Plurality", "Approval", "Ranked choice"];

const PRESSED = "h-12 px-4 text-sm aria-pressed:bg-foreground aria-pressed:text-background";

function FilterGroup<T extends string>({
  label,
  options,
  field,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  field: (row: RegisterRow) => T;
  value: T[];
  onChange: (value: T[]) => void;
}) {
  const labelId = useId();
  return (
    <div className="grid content-start gap-3 border-t border-border pt-4 md:grid-cols-12 md:items-center md:gap-x-6">
      <Micro className="md:col-span-2">
        <span id={labelId}>{label}</span>
      </Micro>
      <ToggleGroup
        multiple
        variant="outline"
        aria-labelledby={labelId}
        value={value}
        onValueChange={(next) => onChange(next as T[])}
        className="w-full flex-wrap md:col-span-10"
      >
        {options.map((option) => (
          <ToggleGroupItem key={option} value={option} className={PRESSED}>
            {option}
            <span className="font-mono text-xs tabular-nums opacity-80">
              {REGISTER.filter((row) => field(row) === option).length}
            </span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function StatusCell({ row }: { row: RegisterRow }) {
  const Icon =
    row.status === "Open" ? CircleDot : row.status === "Scheduled" ? Clock : CircleCheckBig;
  const tone =
    row.status === "Open"
      ? "text-recorded"
      : row.status === "Scheduled"
        ? "text-pending"
        : "text-muted-foreground";
  return (
    <span className="grid gap-1">
      <span className="flex items-center gap-2 text-sm font-medium">
        <Icon aria-hidden="true" className={`size-4 ${tone}`} />
        {row.status}
        {row.counted === true ? (
          <span className="font-normal text-muted-foreground">· counted</span>
        ) : null}
      </span>
      <span className="font-mono text-xs text-muted-foreground">{row.when}</span>
    </span>
  );
}

function RegisterItem({ row, number }: { row: RegisterRow; number: number }) {
  const titleId = useId();
  const dt =
    "font-mono text-[0.6875rem] tracking-widest text-muted-foreground uppercase md:sr-only";
  return (
    <li className="reveal border-b border-border">
      <article
        aria-labelledby={titleId}
        className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto] gap-x-3 gap-y-4 py-6 md:grid-cols-12 md:items-baseline md:gap-x-6"
      >
        <span className="pt-1 font-mono text-xs text-muted-foreground tabular-nums md:col-span-1 md:pt-0">
          {String(number).padStart(3, "0")}
        </span>
        <div className="grid min-w-0 gap-1 md:col-span-4">
          <h3 id={titleId} className="m-0 text-lg leading-snug font-medium text-pretty">
            <a
              href={`/polls/${row.slug}`}
              className="underline-offset-4 hover:underline focus-visible:underline"
            >
              {row.title}
            </a>
          </h3>
          <p className="m-0 text-sm text-muted-foreground">{row.scope}</p>
        </div>
        <span className="row-start-1 justify-self-end md:order-last md:col-span-1 md:row-start-auto">
          <Fingerprint
            value={row.id}
            label={`Fingerprint of poll ${row.id.slice(0, 4)} ${row.id.slice(4, 8)}`}
            size={36}
          />
        </span>
        <dl className="col-span-3 col-start-1 m-0 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-[1fr_1.4fr_auto] md:contents">
          <div className="grid content-start gap-1 md:col-span-2">
            <dt className={dt}>Kind and method</dt>
            <dd className="m-0 grid text-sm">
              <span>{row.kind}</span>
              <span className="text-muted-foreground">{row.method}</span>
            </dd>
          </div>
          <div className="col-span-2 row-start-1 grid content-start gap-1 sm:col-span-1 sm:row-start-auto md:col-span-3">
            <dt className={dt}>Status</dt>
            <dd className="m-0">
              <StatusCell row={row} />
            </dd>
          </div>
          <div className="grid content-start gap-1 md:col-span-1 md:text-end">
            <dt className={dt}>Entries</dt>
            <dd className="m-0 font-mono text-sm">
              <Count value={row.entries} />
            </dd>
          </div>
        </dl>
      </article>
    </li>
  );
}

function Featured() {
  const tier2 = LEVY.results.find((r) => r.tier === "tier2");
  const yes = tier2?.counts["yes"] ?? 0;
  const ballots = tier2?.ballots ?? 0;
  const share = ballots > 0 ? yes / ballots : 0;
  const percent = new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 1,
  }).format(share);
  const tile = "reveal grid content-start gap-5 py-8 md:px-8 md:py-2 md:first:ps-0 md:last:pe-0";
  return (
    <ul className="m-0 grid list-none border-y border-foreground p-0 md:grid-cols-3 md:divide-x md:divide-border md:py-8">
      <li className={`${tile} border-b border-border md:border-b-0`}>
        <article aria-labelledby="featured-levy" className="grid gap-5">
          <div className="flex items-start justify-between gap-4">
            <Micro>Closed · counted</Micro>
            <Fingerprint value={LEVY.id} label="Fingerprint of poll b0f7 0f97" size={32} />
          </div>
          <h3 id="featured-levy" className="m-0 font-heading text-2xl leading-tight font-semibold">
            <a href={`/polls/${LEVY.slug}`} className="underline-offset-4 hover:underline">
              {LEVY.title}
            </a>
          </h3>
          <div className="grid gap-2">
            <p className="m-0 font-heading text-5xl font-semibold tabular-nums">{percent}</p>
            <p className="m-0 text-sm">
              voted yes among <Count value={ballots} /> document-verified voters (Tier 2).
            </p>
            <span aria-hidden="true" className="mt-1 block h-2 bg-muted">
              <span
                className="draw-x block h-full bg-primary"
                style={{ width: `${share * 100}%` }}
              />
            </span>
          </div>
          <p className="m-0 text-sm text-muted-foreground">
            Vouched and passkey-only voters are counted on their own, on the poll&rsquo;s page.
          </p>
        </article>
      </li>
      <li className={`${tile} border-b border-border md:border-b-0`}>
        <article aria-labelledby="featured-westbrook" className="grid gap-5">
          <div className="flex items-start justify-between gap-4">
            <Micro>Open · closes 9 Nov, 20:00 UTC</Micro>
            <Fingerprint
              value={WESTBROOK_ID}
              label={`Fingerprint of poll ${WESTBROOK_ID.slice(0, 4)} ${WESTBROOK_ID.slice(4, 8)}`}
              size={32}
            />
          </div>
          <h3
            id="featured-westbrook"
            className="m-0 font-heading text-2xl leading-tight font-semibold"
          >
            <a
              href="/polls/westbrook-school-start-times"
              className="underline-offset-4 hover:underline"
            >
              Later school start times in Westbrook
            </a>
          </h3>
          <div className="grid gap-2">
            <p className="m-0 font-heading text-5xl font-semibold tabular-nums">
              <Count value={18_204} />
            </p>
            <p className="m-0 text-sm">entries on its board so far, as of {AS_OF}.</p>
          </div>
          <p className="m-0 text-sm text-muted-foreground">
            Ballots stay encrypted until the trustees count them, so there is no running result.
          </p>
        </article>
      </li>
      <li className={tile}>
        <article aria-labelledby="featured-transit" className="grid gap-5">
          <div className="flex items-start justify-between gap-4">
            <Micro>Scheduled</Micro>
            <Fingerprint value={TRANSIT.id} label="Fingerprint of poll e51f 53ab" size={32} />
          </div>
          <h3
            id="featured-transit"
            className="m-0 font-heading text-2xl leading-tight font-semibold"
          >
            <a href={`/polls/${TRANSIT.slug}`} className="underline-offset-4 hover:underline">
              {TRANSIT.title}
            </a>
          </h3>
          <div className="grid gap-2">
            <p className="m-0 font-heading text-5xl font-semibold">8 Dec</p>
            <p className="m-0 text-sm">opens at 06:00 UTC, for {TRANSIT.scope.toLowerCase()}.</p>
          </div>
          <p className="m-0 text-sm text-muted-foreground">
            The question and options are already fixed in its published definition.
          </p>
        </article>
      </li>
    </ul>
  );
}

export function PollsIndexPage({ initialQuery = "" }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [statuses, setStatuses] = useState<PollStatus[]>([]);
  const [kinds, setKinds] = useState<PollKind[]>([]);
  const [methods, setMethods] = useState<PollMethod[]>([]);
  const searchId = useId();
  const hintId = useId();

  const needle = query.trim().toLowerCase();
  const rows = REGISTER.filter(
    (row) =>
      (statuses.length === 0 || statuses.includes(row.status)) &&
      (kinds.length === 0 || kinds.includes(row.kind)) &&
      (methods.length === 0 || methods.includes(row.method)) &&
      (needle === "" || `${row.title} ${row.scope}`.toLowerCase().includes(needle)),
  );
  const filtered = needle !== "" || statuses.length + kinds.length + methods.length > 0;
  const clear = () => {
    setQuery("");
    setStatuses([]);
    setKinds([]);
    setMethods([]);
  };

  return (
    <MockShell current="/polls">
      <PageHead
        eyebrow="Register of polls"
        title="Every poll on the record"
        lede="Referendums, organisations' votes and open polls, each with a public board anyone can recount. Listed here by when they close; the election registry on Ethereum names every poll, whatever this list shows."
      >
        <dl className="m-0 mt-4 grid grid-cols-2 gap-x-8 gap-y-6 border-t border-foreground pt-5 sm:grid-cols-4">
          {[
            { label: "Listed polls", value: LISTED_TOTAL },
            { label: "Open now", value: 212 },
            { label: "Scheduled", value: 41 },
          ].map(({ label, value }) => (
            <div key={label} className="grid gap-1">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="m-0 font-heading text-3xl font-semibold">
                <Count value={value} />
              </dd>
            </div>
          ))}
          <div className="grid gap-1">
            <dt className="text-sm text-muted-foreground">As of</dt>
            <dd className="m-0 pt-2 font-mono text-xs">{AS_OF}</dd>
          </div>
        </dl>
      </PageHead>

      <Section
        index="01"
        mark="Civic referendums"
        title="Questions put to whole communities"
        lede="Referendums open to every resident of a place. Results are shown per verification tier, never as one blended number."
      >
        <Featured />
      </Section>

      <Section
        index="02"
        mark="The register"
        title="Find a poll"
        lede="Filter by status, kind and counting method, or search titles and scopes. Leave a group unselected to include all of it."
      >
        <div className="grid gap-6 md:grid-cols-12">
          <div className="grid gap-3 pb-2 md:col-span-12">
            <label htmlFor={searchId} className="text-sm font-medium">
              Search titles and scopes
            </label>
            <div className="relative max-w-2xl">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id={searchId}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-describedby={hintId}
                autoComplete="off"
                className="h-12 ps-11 text-base md:text-base"
              />
            </div>
            <p id={hintId} className="m-0 text-sm text-muted-foreground">
              For example a place, an organisation or a topic.
            </p>
          </div>
          <div className="md:col-span-12">
            <FilterGroup
              label="Status"
              options={STATUSES}
              field={(r) => r.status}
              value={statuses}
              onChange={setStatuses}
            />
          </div>
          <div className="md:col-span-12">
            <FilterGroup
              label="Kind"
              options={KINDS}
              field={(r) => r.kind}
              value={kinds}
              onChange={setKinds}
            />
          </div>
          <div className="md:col-span-12">
            <FilterGroup
              label="Method"
              options={METHODS}
              field={(r) => r.method}
              value={methods}
              onChange={setMethods}
            />
          </div>
        </div>

        <div className="grid gap-0">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-4">
            <p aria-live="polite" className="m-0 text-sm">
              <span className="font-medium">
                {rows.length} of {REGISTER.length}
              </span>{" "}
              polls on this page match.
            </p>
            {filtered ? (
              <Button variant="link" onClick={clear}>
                Clear filters
              </Button>
            ) : null}
          </div>
          <div
            aria-hidden="true"
            className="hidden grid-cols-12 gap-x-6 border-y border-foreground py-3 md:grid"
          >
            <Micro className="col-span-1">No.</Micro>
            <Micro className="col-span-4">Poll and scope</Micro>
            <Micro className="col-span-2">Kind · method</Micro>
            <Micro className="col-span-3">Status</Micro>
            <Micro className="col-span-1 text-end">Entries</Micro>
            <Micro className="col-span-1 text-end">ID</Micro>
          </div>
          {rows.length === 0 ? (
            <Empty className="border border-t-0 border-border py-16 md:border-t-0">
              <EmptyHeader className="max-w-md">
                <h3 className="m-0 font-heading text-2xl font-semibold">No polls match</h3>
                <EmptyDescription className="text-sm text-muted-foreground">
                  Nothing on this page of the register matches
                  {needle === "" ? (
                    " these filters"
                  ) : (
                    <> &ldquo;{query.trim()}&rdquo; with these filters</>
                  )}
                  . A poll that moderation has delisted isn&rsquo;t listed here, but it stays open
                  by its ID and the registry on Ethereum still names it.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent className="flex-row flex-wrap justify-center gap-3">
                <Button variant="outline" onClick={clear}>
                  Clear filters
                </Button>
                <a
                  href="/polls?id="
                  className="inline-flex h-12 items-center gap-2 px-4 text-sm underline decoration-primary underline-offset-4"
                >
                  Open a poll by its ID <ArrowRight aria-hidden="true" className="size-4" />
                </a>
              </EmptyContent>
            </Empty>
          ) : (
            <ol
              aria-label="Polls"
              className="m-0 list-none border-t border-foreground p-0 md:border-t-0"
            >
              {rows.map((row) => (
                <RegisterItem key={row.id} row={row} number={REGISTER.indexOf(row) + 1} />
              ))}
            </ol>
          )}
        </div>

        <Pagination aria-label="Register pages" className="justify-between gap-4">
          <p className="m-0 hidden self-center font-mono text-xs text-muted-foreground sm:block">
            Page 1 of {REGISTER_PAGES}
          </p>
          <PaginationContent className="flex-wrap">
            <PaginationItem>
              <PaginationLink href="#" isActive aria-label="Page 1">
                1
              </PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#" aria-label="Page 2">
                2
              </PaginationLink>
            </PaginationItem>
            <PaginationItem className="hidden sm:block">
              <PaginationLink href="#" aria-label="Page 3">
                3
              </PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationEllipsis />
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#" aria-label={`Page ${REGISTER_PAGES}`}>
                {REGISTER_PAGES}
              </PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationNext href="#" />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </Section>
    </MockShell>
  );
}
