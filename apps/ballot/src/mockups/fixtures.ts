// Sample data for the ballot client's screen mockups (Storybook only). Places,
// organisations, people and hashes are invented; nothing here is a real
// election. Hashes shared with the website's mockups (apps/web/src/mockups)
// are copied, not imported, so the two sets of screens show the same record.

export type BallotMethod = "plurality" | "approval" | "ranked";

export interface BallotOption {
  key: string;
  label: string;
  /** A short line under the label, as the election's display text holds it. */
  note?: string;
}

export interface BallotElection {
  id: string;
  /** What the top bar shows. */
  shortName: string;
  title: string;
  organiser: string;
  /** Who may vote, in words. */
  scope: string;
  /** The tier a voter proves to take part. */
  tier: { short: string; name: string };
  /** The question exactly as the registered display text holds it. */
  question: string;
  method: BallotMethod;
  /** The most options a voter may choose (approval) or rank (ranked choice). */
  maxChoices: number;
  options: readonly BallotOption[];
  opens: string;
  closes: string;
  /** The definition's hash, as the L2 election registry holds it. */
  definitionHash: string;
  /** The page on the website with the election's record and results. */
  url: string;
}

export const LEVY: BallotElection = {
  id: "b0f70f97076d5a1ad14ad276cc6c9114f4129fead79fc78fdc78bb3eaf5e2647",
  shortName: "Library levy",
  title: "Alder County library levy",
  organiser: "Friends of the Alder County Libraries",
  scope: "Residents of Alder County, 18 and over",
  tier: { short: "Tier 2", name: "Document-verified" },
  question:
    "Should Alder County renew the 0.2% library levy for another ten years, funding the county's 14 branch libraries?",
  method: "plurality",
  maxChoices: 1,
  options: [
    { key: "yes", label: "Yes, renew the levy" },
    { key: "no", label: "No, let it expire" },
  ],
  opens: "3 November 2026, 06:00 UTC",
  closes: "3 November 2026, 20:00 UTC",
  definitionHash: "03f6b0046ca591110fdf4f91f0199bc14ab68dafd018eaddfecb94ff838fb5a8",
  url: "https://abolish.us/polls/alder-county-library-levy",
};

export const PARK: BallotElection = {
  id: "b1a71203bc63c46c88c27d024456c4d70c953a796284a33280b376fabc89c490",
  shortName: "Riverside park",
  title: "Riverside park improvements",
  organiser: "Riverside Neighbourhood Association",
  scope: "Anyone with an account",
  tier: { short: "Tier 0", name: "Passkey only" },
  question: "Which improvements should the Riverside neighbourhood association ask the city for?",
  method: "approval",
  maxChoices: 4,
  options: [
    { key: "lights", label: "Better lighting on the river path" },
    { key: "toilets", label: "Public toilets open all year" },
    { key: "courts", label: "Resurfaced basketball courts" },
    { key: "trees", label: "Two hundred new street trees" },
  ],
  opens: "1 November 2026, 12:00 UTC",
  closes: "15 November 2026, 12:00 UTC",
  definitionHash: "4095dc37150f8a05e5f63c47a6347ccc4f36e7d64002cf4c6156c57fbc9650a9",
  url: "https://abolish.us/polls/riverside-park-improvements",
};

/** The same poll with a limit, so the overvote rule has something to stop. */
export const PARK_LIMITED: BallotElection = { ...PARK, maxChoices: 2 };

export const TENANTS: BallotElection = {
  id: "2fde91727a2e0c67edf0ba1c54c8b83c14116b87e267057c03732840019d5508",
  shortName: "Tenants' union board",
  title: "Tenants' union board seat",
  organiser: "Harbor Tenants' Union",
  scope: "Members of the Harbor Tenants' Union",
  tier: { short: "Tier 0", name: "Passkey only" },
  question: "Rank the candidates for the open seat on the Harbor Tenants' Union board.",
  method: "ranked",
  maxChoices: 3,
  options: [
    { key: "okafor", label: "Adaeze Okafor", note: "Building rep, Pier Street Apartments" },
    { key: "lindqvist", label: "Mara Lindqvist", note: "Treasurer since 2024" },
    { key: "reyes", label: "Tomás Reyes", note: "Organiser, East Harbor repairs campaign" },
  ],
  opens: "20 October 2026, 00:00 UTC",
  closes: "27 October 2026, 00:00 UTC",
  definitionHash: "4b7b0f6a0f2d139e82a23ae8d1bdd807704db1f6a8dac316b50d6c4f2c04bf66",
  url: "https://abolish.us/polls/tenants-union-board",
};

/** This copy of the ballot client, as its signed release record names it. */
export const CLIENT = {
  version: "1.4.0",
  hash: "723b32ae7b2379f360c1f1f2eb64cb4dcbe603f86f764ded7920acf58a7380a3",
  cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  origin: "abolish.ch",
};

/** Where the website and the client can be reached; any of them will do. */
export const ENTRY_POINTS = [
  { name: "abolish.us", note: "Primary. A US-administered domain, so not trusted alone." },
  { name: "abolishus.eth", note: "On Ethereum, reached through any IPFS gateway." },
  { name: "abolish.ch", note: "Second domain outside US administration." },
] as const;

/** A shared IPFS path gateway the client refuses to run from. */
export const SHARED_GATEWAY_URL =
  "https://ipfs.example.net/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/";

/** The definition hash served in the failed-check variant, unlike the registry's. */
export const TAMPERED_DEFINITION_HASH =
  "d121be3103007b41edf96f8262925f8c7d61894afe9a041843b631f69445bc57";

/** The sealed (encrypted) ballot this device made, before casting or checking it. */
export const SEALED = {
  hash: "5e3eb011cb673f6a53fbb6e4365e8dcc598b0f409d4267c5e9438b8020d913b1",
  /** The randomness that opens it, published when a ballot is checked. */
  opening: "2b3fdf05c4dda454998927370bf2cf20b0c17bcf1e3d3f294a550e341033ed61",
  spoiledEntry: 1_206,
  spoiledAt: "3 November 2026, 14:01:47 UTC",
};

export const RECEIPT = {
  hash: "1bddad592bb3d9a79ed30408fa786fbfaf6f11f091d44f3947d2b471bd8c1a5d",
  entry: 1_203,
  recordedAt: new Date("2026-11-03T14:02:12Z"),
  nextAnchor: "Next anchor at 15:00 UTC",
};

/** A receipt this device kept from an earlier ballot in the same poll. */
export const PRIOR_RECEIPT = {
  hash: "df357635f594273592619dff7c6584b01c0c9831822ed1c582027efc9ad29913",
  entry: 812,
  recordedAt: "3 November 2026, 11:46:30 UTC",
};

export const BOARD_HEAD = {
  hash: "a7f75861df50949f84978496586daecc980e01db21b31b0462920193e9644a96",
  entries: 161_874,
};

/** The board around the voter's receipt. */
export const BOARD_EXCERPT = [
  {
    index: 1_201,
    time: "14:01:58 UTC",
    kind: "Ballot",
    hash: "5e2d5d1e58e94d7607e0745cd3e612c4a358fc93f37fc5ab1fed8d04bbf7ce77",
  },
  {
    index: 1_202,
    time: "14:02:05 UTC",
    kind: "Ballot",
    hash: "edda7b47233f9790fcc6d116d0a0c0eac38a5d6e44b7cf0c002c6d30bfa61e74",
  },
  { index: RECEIPT.entry, time: "14:02:12 UTC", kind: "Ballot", hash: RECEIPT.hash },
  {
    index: 1_204,
    time: "14:02:19 UTC",
    kind: "Ballot",
    hash: "6e18ec763c0751ffab6eddca795cf9a03b16c59b30cc266b9281a23a55897359",
  },
] as const;

/** Seed for the drawn QR placeholder on the Tier 2 handoff screen. */
export const PROOF_REQUEST = {
  hash: "d847acf7bab1b6f761779f3995c693e25eb899dceea61ef9043532d1ae9923a6",
  apps: ["zkPassport", "Self"],
};

/** "03f6 b004": the first eight digits, grouped, for labels a screen reader reads. */
export function shortHex(hash: string): string {
  return `${hash.slice(0, 4)} ${hash.slice(4, 8)}`;
}

/** "Members of the union" → "members of the union", for use mid-sentence. */
export function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
