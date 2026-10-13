// A simulation scenario (docs/PROJECT_BRIEF.md: "a 10,000-voter national
// referendum simulation with 7 trustees, two offline, mixed identity tiers,
// our servers down halfway through"): the parameters an operator or an agent
// gives, parsed strictly from JSON so a typo is refused rather than silently
// defaulted (T-31).

import { PARAMETERS, TIERS } from "@abolishus/crypto";

/**
 * The largest electorate a scenario may ask for. A run costs about 0.3 s per
 * ballot on one core at 7 seats, mostly each online seat's intake, so
 * 10,000 voters take about an hour and this many about ten.
 */
export const MAX_SIMULATED_VOTERS = 100_000;

/**
 * The most `ballots × options × panel` a scenario may ask for, where a
 * scenario with re-votes counts two ballots per voter. A run keeps every
 * ballot's VSS commitments, `options × threshold` points, and each online
 * seat's `options` shares of it until the re-vote rule has selected the
 * counted ballots, so this bounds its memory at about a gigabyte.
 */
export const MAX_SIMULATED_WORK = 2_000_000;

/**
 * The most `openings × ballots × options` a scenario with published
 * openings may ask for, taking every voter's challenged attempt as
 * published and every voter as re-voting when the shares allow it. Before
 * boarding an opening the operator compares each counted ballot's
 * commitments with what it opens (docs/spec/challenge.md, Publication:
 * `opening-cast`), one point encoding each, about 0.1 ms, so this bounds
 * that check at about a quarter of an hour. Each published opening also
 * costs its own checks and about `4 × options × (threshold + panel)` scalar
 * multiplications to list what it opens, so a run where many voters
 * publish takes noticeably longer per ballot than one where none do.
 */
export const MAX_SIMULATED_OPENING_LOOKUPS = 10_000_000;

/** The definition's tiers, each one cell of the electorate. */
export const SIMULATED_TIERS = TIERS;
export type SimulatedTier = (typeof SIMULATED_TIERS)[number];

export interface Scenario {
  readonly voters: number;
  /** Plurality is one option or none per ballot; approval any subset. */
  readonly election: "plurality" | "approval";
  readonly options: number;
  readonly trustees: {
    /** `n`. */
    readonly panel: number;
    /** `k`. */
    readonly threshold: number;
    /**
     * Seats that take part in the key ceremony, then are down for the whole
     * voting period and the tally: they receive no ballot and send nothing.
     */
    readonly offline: readonly number[];
    /** Seats that take part but send wrong summed shares at the tally. */
    readonly faulty: readonly number[];
    /**
     * Seats that take part in the ceremony and take ballots, then go down at
     * `at`, a share of the voting period in `(0, 1]`, for the rest of the
     * voting period, the tally and destruction: each takes every ballot cast
     * before `at` and none from then on. Ascending by seat; empty (or no
     * field) for none.
     */
    readonly departures: readonly { readonly seat: number; readonly at: number }[];
  };
  /** Each tier's relative share of the voters; a tier of weight 0 isn't in the electorate. */
  readonly tiers: Readonly<Record<`${SimulatedTier}`, number>>;
  /**
   * The share of the voting period, `[from, to)` of `[0, 1]`, when our servers
   * refuse ballots; `null` (or no field) for none.
   */
  readonly outage: { readonly from: number; readonly to: number } | null;
  /**
   * The share of voters, in `[0, 1]`, who challenge one attempt (a Benaloh
   * challenge, docs/spec/challenge.md) before casting a fresh one; 0 (or no
   * field) for none.
   */
  readonly challenges: number;
  /**
   * The share of voters, in `[0, 1]`, who cast a ballot earlier in the
   * voting period and then re-vote (docs/spec/revoting.md): only the later
   * ballot counts. 0 (or no field) for none.
   */
  readonly revotes: number;
  /**
   * The share of challenging voters, in `[0, 1]`, who ask after close for
   * their challenged attempt's opening to be published on the board
   * (docs/spec/challenge.md, Client rule 4): publishing is the voter's
   * choice, so 0 (or no field) for none.
   */
  readonly publications: number;
  /**
   * The share of ballots, in `[0, 1]`, whose voter, finding the intake of a
   * seat down at its cast (offline or departed) unreachable by every route,
   * chooses to post that seat's share publicly through the contract path
   * (docs/spec/delivery.md, Client rules 4), which lowers that seat's
   * long-term privacy for the ballot, and with `k` or more seats down makes the ballot readable whole to anyone who later
   * breaks the shares' classical encryption (T-15). A voter who declines
   * leaves that ballot undelivered, and it counts nothing, nor does an
   * earlier one in its place: every qualified seat needs a receipt or a
   * posting. Posting is the voter's
   * choice, so 0 (or no field) for none.
   */
  readonly postings: number;
  /**
   * The share of voters, in `[0, 1]`, whose last ballot names an L1 block
   * that is reorganised away after the client named it 2 deep (a reorganisation
   * deeper than Client rule 2 allows for, docs/spec/revoting.md), so the
   * verifier rejects it. The client sees this once the block is finalized
   * and casts the same committed vote again under a new reference (Client
   * rule 4); when that would be after close, the ballot is lost and the
   * voter's earlier ballot, if any, counts instead (Residuals). 0 (or no
   * field) for none.
   */
  readonly reorgs: number;
  /** Seeds the plan only (who votes how and when), never a secret. */
  readonly seed: number;
}

export type ScenarioResult =
  | { readonly ok: true; readonly scenario: Scenario }
  | { readonly ok: false; readonly path: string; readonly error: string };

class Refusal extends Error {
  constructor(
    readonly path: string,
    readonly error: string,
  ) {
    super(`${path}: ${error}`);
  }
}

type Json = Readonly<Record<string, unknown>>;

function object(
  v: unknown,
  path: string,
  keys: readonly string[],
  optional: readonly string[] = [],
): Json {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Refusal(path, "expected an object");
  const o = v as Json;
  for (const k of Object.keys(o))
    if (!keys.includes(k) && !optional.includes(k))
      throw new Refusal(`${path}.${k}`, "unknown field");
  for (const k of keys) if (!Object.hasOwn(o, k)) throw new Refusal(`${path}.${k}`, "missing");
  return o;
}

function integer(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
    throw new Refusal(path, `expected an integer from ${min} to ${max}`);
  return v;
}

function fraction(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)
    throw new Refusal(path, "expected a number from 0 to 1");
  return v;
}

function seats(v: unknown, path: string, panel: number): number[] {
  if (!Array.isArray(v)) throw new Refusal(path, "expected an array of seats");
  // Array.from visits holes too, so a sparse array is refused rather than skipped.
  const out = Array.from(v, (s: unknown, i) => integer(s, `${path}[${i}]`, 1, panel));
  for (let i = 1; i < out.length; i++)
    if ((out[i - 1] as number) >= (out[i] as number))
      throw new Refusal(path, "seats are distinct and ascending");
  return out;
}

function departing(v: unknown, path: string, panel: number): Scenario["trustees"]["departures"] {
  if (!Array.isArray(v)) throw new Refusal(path, "expected an array of departures");
  // Array.from visits holes too, so a sparse array is refused rather than skipped.
  const out = Array.from(v, (d: unknown, i) => {
    const o = object(d, `${path}[${i}]`, ["seat", "at"]);
    const seat = integer(o["seat"], `${path}[${i}].seat`, 1, panel);
    const at = fraction(o["at"], `${path}[${i}].at`);
    // A seat down from the start is an offline one.
    if (at === 0)
      throw new Refusal(`${path}[${i}].at`, "above 0: a seat down from the start is offline");
    return { seat, at };
  });
  for (let i = 1; i < out.length; i++)
    if ((out[i - 1]?.seat as number) >= (out[i]?.seat as number))
      throw new Refusal(path, "seats are distinct and ascending");
  return out;
}

function parse(input: unknown): Scenario {
  const o = object(
    input,
    "$",
    ["voters", "election", "options", "trustees", "tiers", "seed"],
    ["outage", "challenges", "revotes", "publications", "postings", "reorgs"],
  );
  const voters = integer(o["voters"], "$.voters", 1, MAX_SIMULATED_VOTERS);
  const election = o["election"];
  if (election !== "plurality" && election !== "approval")
    throw new Refusal("$.election", 'expected "plurality" or "approval"');
  const options = integer(o["options"], "$.options", 2, PARAMETERS.MAX_OPTIONS);

  const t = object(
    o["trustees"],
    "$.trustees",
    ["panel", "threshold"],
    ["offline", "faulty", "departures"],
  );
  const panel = integer(t["panel"], "$.trustees.panel", 2, PARAMETERS.MAX_TRUSTEES);
  const threshold = integer(t["threshold"], "$.trustees.threshold", 2, panel);
  const offline = Object.hasOwn(t, "offline")
    ? seats(t["offline"], "$.trustees.offline", panel)
    : [];
  const faulty = Object.hasOwn(t, "faulty") ? seats(t["faulty"], "$.trustees.faulty", panel) : [];
  if (faulty.some((s) => offline.includes(s)))
    throw new Refusal("$.trustees.faulty", "a seat is either offline or faulty");
  const departures = Object.hasOwn(t, "departures")
    ? departing(t["departures"], "$.trustees.departures", panel)
    : [];
  for (const [i, d] of departures.entries())
    if (offline.includes(d.seat) || faulty.includes(d.seat))
      throw new Refusal(
        `$.trustees.departures[${i}].seat`,
        "a departing seat is neither offline nor faulty",
      );

  const w = object(o["tiers"], "$.tiers", [], ["0", "1", "2"]);
  const tiers = { "0": 0, "1": 0, "2": 0 };
  for (const k of SIMULATED_TIERS)
    if (Object.hasOwn(w, `${k}`)) tiers[`${k}`] = integer(w[`${k}`], `$.tiers.${k}`, 0, 1_000_000);
  if (tiers["0"] + tiers["1"] + tiers["2"] === 0)
    throw new Refusal("$.tiers", "at least one tier has a positive weight");

  let outage: Scenario["outage"] = null;
  if (Object.hasOwn(o, "outage") && o["outage"] !== null) {
    const r = object(o["outage"], "$.outage", ["from", "to"]);
    const from = fraction(r["from"], "$.outage.from");
    const to = fraction(r["to"], "$.outage.to");
    if (from >= to) throw new Refusal("$.outage", "from is before to");
    outage = { from, to };
  }
  const challenges = Object.hasOwn(o, "challenges") ? fraction(o["challenges"], "$.challenges") : 0;
  const revotes = Object.hasOwn(o, "revotes") ? fraction(o["revotes"], "$.revotes") : 0;
  // How many voters re-vote is drawn by the plan, so the bound takes the most
  // a positive share can give: every voter casting twice.
  if ((revotes > 0 ? 2 : 1) * voters * options * panel > MAX_SIMULATED_WORK)
    throw new Refusal(
      "$",
      `voters × options × panel (doubled with re-votes) is at most ${MAX_SIMULATED_WORK}`,
    );
  const publications = Object.hasOwn(o, "publications")
    ? fraction(o["publications"], "$.publications")
    : 0;
  const reorgs = Object.hasOwn(o, "reorgs") ? fraction(o["reorgs"], "$.reorgs") : 0;
  // Who publishes is drawn by the plan too, so the bound takes every voter
  // publishing against every ballot cast, a recast after a reorganisation
  // included.
  const ballots = ((revotes > 0 ? 2 : 1) + (reorgs > 0 ? 1 : 0)) * voters;
  if (
    challenges > 0 &&
    publications > 0 &&
    voters * ballots * options > MAX_SIMULATED_OPENING_LOOKUPS
  )
    throw new Refusal(
      "$",
      `with published openings, voters × ballots × options is at most ${MAX_SIMULATED_OPENING_LOOKUPS}`,
    );
  const postings = Object.hasOwn(o, "postings") ? fraction(o["postings"], "$.postings") : 0;
  const seed = integer(o["seed"], "$.seed", 0, 0xffff_ffff);
  return {
    voters,
    election,
    options,
    trustees: { panel, threshold, offline, faulty, departures },
    tiers,
    outage,
    challenges,
    revotes,
    publications,
    postings,
    reorgs,
    seed,
  };
}

/** Parses a scenario from decoded JSON, refusing unknown fields and out-of-range values with the path of the first. */
export function parseScenario(input: unknown): ScenarioResult {
  try {
    return { ok: true, scenario: parse(input) };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, path: e.path, error: e.error };
    throw e;
  }
}
