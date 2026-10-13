// Sample register for the polls index mockup (Storybook only). Invented, like
// fixtures.ts: no real poll, organisation or count.

import { COUNCIL, LEVY, PARKS, TRANSIT } from "./fixtures.ts";
import { sampleHash } from "./board-data.ts";

export type PollStatus = "Open" | "Scheduled" | "Closed";
export type PollKind = "Referendum" | "Organisational vote" | "Open poll";
export type PollMethod = "Plurality" | "Approval" | "Ranked choice";

export interface RegisterRow {
  id: string;
  slug: string;
  title: string;
  kind: PollKind;
  method: PollMethod;
  scope: string;
  status: PollStatus;
  /** The time that matters for the status, in the board's time zone. */
  when: string;
  /** Closed and counted, with the tally on the board. */
  counted?: boolean;
  entries: number;
}

function row(r: Omit<RegisterRow, "id"> & { id?: string }): RegisterRow {
  return { ...r, id: r.id ?? sampleHash(r.slug) };
}

export const REGISTER: readonly RegisterRow[] = [
  row({
    id: PARKS.id,
    slug: PARKS.slug,
    title: PARKS.title,
    kind: "Open poll",
    method: "Approval",
    scope: PARKS.scope,
    status: "Open",
    when: "Closes 15 Nov 2026, 12:00 UTC",
    entries: PARKS.entries,
  }),
  row({
    slug: "westbrook-school-start-times",
    title: "Later school start times in Westbrook",
    kind: "Referendum",
    method: "Plurality",
    scope: "Residents of the Westbrook school district",
    status: "Open",
    when: "Closes 9 Nov 2026, 20:00 UTC",
    entries: 18_204,
  }),
  row({
    slug: "mesa-mutual-aid-budget",
    title: "Mesa Mutual Aid Network budget for 2027",
    kind: "Organisational vote",
    method: "Approval",
    scope: "Members of the Mesa Mutual Aid Network",
    status: "Open",
    when: "Closes 6 Nov 2026, 18:00 UTC",
    entries: 342,
  }),
  row({
    slug: "northfield-library-hours",
    title: "Northfield Library Cooperative opening hours",
    kind: "Organisational vote",
    method: "Ranked choice",
    scope: "Members of the Northfield Library Cooperative",
    status: "Open",
    when: "Closes 12 Nov 2026, 17:00 UTC",
    entries: 1_077,
  }),
  row({
    slug: "car-free-sundays-main-street",
    title: "Car-free Sundays on Main Street",
    kind: "Open poll",
    method: "Approval",
    scope: "Anyone with an account",
    status: "Open",
    when: "Closes 20 Nov 2026, 12:00 UTC",
    entries: 9_315,
  }),
  row({
    id: TRANSIT.id,
    slug: TRANSIT.slug,
    title: TRANSIT.title,
    kind: "Referendum",
    method: "Plurality",
    scope: TRANSIT.scope,
    status: "Scheduled",
    when: "Opens 8 Dec 2026, 06:00 UTC",
    entries: 0,
  }),
  row({
    slug: "harbor-rent-stabilisation",
    title: "Rent stabilisation ordinance for Harbor",
    kind: "Referendum",
    method: "Plurality",
    scope: "Residents of the city of Harbor, 18 and over",
    status: "Scheduled",
    when: "Opens 17 Nov 2026, 06:00 UTC",
    entries: 0,
  }),
  row({
    slug: "harbor-press-guild-contract",
    title: "Harbor Press Guild contract ratification",
    kind: "Organisational vote",
    method: "Plurality",
    scope: "Members of the Harbor Press Guild",
    status: "Scheduled",
    when: "Opens 10 Nov 2026, 14:00 UTC",
    entries: 0,
  }),
  row({
    id: LEVY.id,
    slug: LEVY.slug,
    title: LEVY.title,
    kind: "Referendum",
    method: "Plurality",
    scope: LEVY.scope,
    status: "Closed",
    counted: true,
    when: "Closed 3 Nov 2026, 20:00 UTC",
    entries: LEVY.entries,
  }),
  row({
    slug: "footbridge-name",
    title: "A name for the new Riverside footbridge",
    kind: "Open poll",
    method: "Ranked choice",
    scope: "Anyone with an account",
    status: "Closed",
    counted: true,
    when: "Closed 30 Oct 2026, 12:00 UTC",
    entries: 6_902,
  }),
  row({
    id: COUNCIL.id,
    slug: COUNCIL.slug,
    title: COUNCIL.title,
    kind: "Organisational vote",
    method: "Ranked choice",
    scope: COUNCIL.scope,
    status: "Closed",
    counted: true,
    when: "Closed 27 Oct 2026, 00:00 UTC",
    entries: COUNCIL.entries,
  }),
  row({
    slug: "state-minimum-wage-indexation",
    title: "Index the state minimum wage to inflation",
    kind: "Referendum",
    method: "Plurality",
    scope: "Residents of the state, 18 and over",
    status: "Closed",
    counted: true,
    when: "Closed 20 Oct 2026, 22:00 UTC",
    entries: 412_880,
  }),
  row({
    slug: "riverside-garden-plots",
    title: "Allocation of Riverside community garden plots",
    kind: "Organisational vote",
    method: "Approval",
    scope: "Members of the Riverside neighbourhood association",
    status: "Closed",
    counted: true,
    when: "Closed 18 Oct 2026, 18:00 UTC",
    entries: 214,
  }),
  row({
    slug: "alder-county-ranked-choice",
    title: "Ranked-choice voting for Alder County offices",
    kind: "Referendum",
    method: "Plurality",
    scope: "Residents of Alder County",
    status: "Closed",
    counted: true,
    when: "Closed 12 Oct 2026, 20:00 UTC",
    entries: 98_410,
  }),
];

export const LISTED_TOTAL = 1_284;
export const REGISTER_PAGES = Math.ceil(LISTED_TOTAL / REGISTER.length);
