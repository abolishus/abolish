// Page-specific sample data for the poll mockups (Storybook only). Invented,
// like fixtures.ts; nothing here is a real election, person or transaction.

import { TIERS, type TierInfo, type TierKey } from "./fixtures.ts";

export function tierInfo(key: TierKey): TierInfo {
  const tier = TIERS.find((t) => t.key === key);
  if (tier === undefined) throw new RangeError(`unknown tier ${key}`);
  return tier;
}

/** The scope phrase a count carries: "document-verified voters". */
export const TIER_VOTERS: Record<TierKey, string> = {
  tier2: "document-verified voters",
  tier1: "vouched voters",
  tier0: "passkey-only voters",
};

export const LEVY_RECORD = {
  ballots: 161_363,
  lastAnchor: {
    at: "3 November 2026, 21:00 UTC",
    block: 21_384_112,
    tx: "9c41d0e7a2b85f36c1e04d7b93a6f2581c0e7d4ab369f2e85d17c4a0b6e3f921",
  },
  registry: "0x7a3e…41c9",
  verifierCid: "bafybeihx3v4kqz2l7m5r6tq2w4e7n3yfj6c5ab2kq7d4r8sgv5h3m2pxle",
  decryptedAt: "3 November 2026, 22:41 UTC",
};

/** For the "decrypting" state: what the board shows before the threshold. */
export const LEVY_DECRYPTING = {
  shares: 3,
  at: "3 November 2026, 21:30 UTC",
};

export const PARKS_LIVE = {
  asOf: "4 November 2026, 09:00 UTC",
  boardHead: "4d0c3e9a71f2b85e6a03c7d41f98b2e5c6a1d07f3b94e82c5a6d1f0e7b3c9a24",
  tiers: [
    {
      tier: "tier2" as const,
      eligible: 148_210,
      ballots: 612,
      days: [
        { label: "1 Nov", note: "from 12:00", value: 148 },
        { label: "2 Nov", note: "", value: 190 },
        { label: "3 Nov", note: "", value: 171 },
        { label: "4 Nov", note: "to 09:00", value: 103 },
      ],
    },
    {
      tier: "tier1" as const,
      eligible: 31_904,
      ballots: 288,
      days: [
        { label: "1 Nov", note: "from 12:00", value: 61 },
        { label: "2 Nov", note: "", value: 94 },
        { label: "3 Nov", note: "", value: 82 },
        { label: "4 Nov", note: "to 09:00", value: 51 },
      ],
    },
    {
      tier: "tier0" as const,
      eligible: 402_775,
      ballots: 1_463,
      days: [
        { label: "1 Nov", note: "from 12:00", value: 402 },
        { label: "2 Nov", note: "", value: 455 },
        { label: "3 Nov", note: "", value: 377 },
        { label: "4 Nov", note: "to 09:00", value: 229 },
      ],
    },
  ],
};

export const PARKS_DELISTING = {
  at: "2 November 2026, 16:20 UTC",
  reason: "Duplicate",
  note: "Same question as an earlier poll from the same association, which stays listed.",
  entry: 3_118,
};

export const TRANSIT_REGISTRY = {
  asOf: "12 October 2026, 00:00 UTC",
  tiers: [
    {
      tier: "tier2" as const,
      weeks: [
        { label: "14 Sep", value: 371_204 },
        { label: "21 Sep", value: 382_950 },
        { label: "28 Sep", value: 391_880 },
        { label: "5 Oct", value: 402_115 },
        { label: "12 Oct", value: 412_880 },
      ],
    },
    {
      tier: "tier1" as const,
      weeks: [
        { label: "14 Sep", value: 88_410 },
        { label: "21 Sep", value: 90_266 },
        { label: "28 Sep", value: 92_031 },
        { label: "5 Oct", value: 94_480 },
        { label: "12 Oct", value: 96_310 },
      ],
    },
    {
      tier: "tier0" as const,
      weeks: [
        { label: "14 Sep", value: 1_021_900 },
        { label: "21 Sep", value: 1_043_120 },
        { label: "28 Sep", value: 1_061_775 },
        { label: "5 Oct", value: 1_084_310 },
        { label: "12 Oct", value: 1_102_540 },
      ],
    },
  ],
};

export type CeremonyState = "posted" | "awaiting";

export const TRANSIT_CEREMONY = {
  transcript: "a8e2f05c93d14b7e6f21c8a0d97b3e45f1c6a2d80e7b94f3c5a1d6e2b08f7c39",
  updated: "11 October 2026, 17:45 UTC",
  threshold: 4,
  steps: [
    { label: "Panel of seven named in the definition", detail: "1 October 2026" },
    { label: "Commitments posted to the board", detail: "6 of 7, as of 11 October" },
    { label: "Shares exchanged and checked by every trustee", detail: "" },
    { label: "Joint election key published", detail: "" },
  ],
  /** By trustee, in fixtures.ts TRUSTEES order. */
  commitments: [
    "posted",
    "posted",
    "posted",
    "posted",
    "posted",
    "awaiting",
    "posted",
  ] as const satisfies readonly CeremonyState[],
};
