// What a poll's link preview may show (docs/design/sharing.md, "What every
// surface shows, and never shows"). A sealed poll's results carry nothing but
// their state: no lead, share, ordering or tier row can be put in one, so no
// card or description drawn from it can show a result (T-67).

/** The latest released lead of the first question, as a sentence and its share (0–1). */
export interface Lead {
  readonly sentence: string;
  readonly share: number;
}

/** One tier's row on the civic record: its own count, never summed with another's. */
export interface TierResult {
  readonly name: string;
  readonly ballots: number;
  /** The share the bar shows (0–1). */
  readonly share: number;
  /** The share in words, as the record reads it ("62.4% yes"). */
  readonly result: string;
}

/** Results while sealed: their state and nothing else. */
export interface Sealed {
  readonly state: "sealed";
}

/** Open, with no released results known to this site: shows when it closes, never a result. */
export interface Open {
  readonly state: "open";
}

/** Closed, with no final count published yet. */
export interface Counting {
  readonly state: "counting";
}

export type EverydayResults =
  | Sealed
  | Open
  | Counting
  | { readonly state: "live"; readonly lead: Lead; readonly releasedAt: string }
  | { readonly state: "closed"; readonly lead: Lead };

export type CivicResults =
  | Sealed
  | Open
  | Counting
  | { readonly state: "live"; readonly tiers: readonly TierResult[]; readonly releasedAt: string }
  | { readonly state: "closed"; readonly tiers: readonly TierResult[] };

interface PreviewBase {
  /** The poll's definition hash (64 lowercase hex): its seal and its short code. */
  readonly seal: string;
  /** This site's host, for the short link ("abolish.us"). */
  readonly host: string;
  /** The first question's text; `undefined` while the API doesn't serve it. */
  readonly question: string | undefined;
  readonly askedBy: string | undefined;
  readonly place: string | undefined;
  readonly questionCount: number;
  /** Answers on the board so far (public anyway); `undefined` if not known. */
  readonly answers: number | undefined;
  /** When it closes, ISO 8601 in UTC; `undefined` if past what a date can hold. */
  readonly closesAt: string | undefined;
}

export interface EverydayPreview extends PreviewBase {
  readonly civic: false;
  readonly results: EverydayResults;
}

export interface CivicPreview extends PreviewBase {
  readonly civic: true;
  /** What kind of record it is ("Referendum"). */
  readonly kind: string;
  readonly results: CivicResults;
}

export type PollPreview = EverydayPreview | CivicPreview;

export type PreviewFormat = "landscape" | "square";

export const PREVIEW_SIZE: Readonly<Record<PreviewFormat, { width: number; height: number }>> = {
  landscape: { width: 1200, height: 630 },
  square: { width: 1080, height: 1080 },
};

const KEYS: Readonly<Record<string, readonly string[]>> = {
  sealed: ["state"],
  open: ["state"],
  counting: ["state"],
};

/**
 * Refuses a model the types would refuse, for values that arrive without
 * them: above all, results that claim to be sealed (or not yet released) but
 * carry anything else.
 */
export function checkPreview(model: PollPreview): void {
  if (!/^[0-9a-f]{64}$/.test(model.seal)) throw new RangeError("seal must be 64 lowercase hex");
  if (!Number.isSafeInteger(model.questionCount) || model.questionCount < 1)
    throw new RangeError("questionCount must be a positive integer");
  if (model.answers !== undefined && (!Number.isSafeInteger(model.answers) || model.answers < 0))
    throw new RangeError("answers must be a count");
  const keys = KEYS[model.results.state];
  if (keys !== undefined && Object.keys(model.results).some((k) => !keys.includes(k)))
    throw new TypeError(`${model.results.state} results carry nothing but their state`);
  const shares =
    "lead" in model.results
      ? [model.results.lead.share]
      : "tiers" in model.results
        ? model.results.tiers.map((t) => t.share)
        : [];
  if (shares.some((s) => !(s >= 0 && s <= 1))) throw new RangeError("a share is from 0 to 1");
}

/** Crockford base32, lower case: no i, l, o or u. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * A poll's short code: the first 35 bits of its definition hash as 7 base32
 * characters (docs/design/sharing.md, "Short links"). A later poll whose
 * prefix is taken needs more; the board decides, so this is the 7-character
 * form only.
 */
export function shortCode(seal: string): string {
  let bits = "";
  for (const digit of seal.slice(0, 9))
    bits += Number.parseInt(digit, 16).toString(2).padStart(4, "0");
  let code = "";
  for (let i = 0; i < 35; i += 5) code += ALPHABET[Number.parseInt(bits.slice(i, i + 5), 2)];
  return code;
}

/** "abolish.us/p/3j55dw1": the link as printed, without the scheme. */
export const shortLink = (model: Pick<PollPreview, "host" | "seal">) =>
  `${model.host}/p/${shortCode(model.seal)}`;
