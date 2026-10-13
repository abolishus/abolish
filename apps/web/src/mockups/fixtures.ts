// Sample data for the page mockups (Storybook only). Places, organisations and
// counts are invented; nothing here is a real election, person or trustee.

export type TierKey = "tier2" | "tier1" | "tier0";

export interface TierInfo {
  key: TierKey;
  name: string;
  short: string;
  description: string;
}

export const TIERS: readonly TierInfo[] = [
  {
    key: "tier2",
    name: "Document-verified",
    short: "Tier 2",
    description: "Proved a government-signed passport or licence, without revealing it.",
  },
  {
    key: "tier1",
    name: "Vouched",
    short: "Tier 1",
    description: "Vouched for by people already verified.",
  },
  {
    key: "tier0",
    name: "Passkey only",
    short: "Tier 0",
    description: "An account with a passkey. Anyone can open many.",
  },
];

export interface Option {
  key: string;
  label: string;
}

export interface TierResult {
  tier: TierKey;
  /** Ballots counted in this tier. */
  ballots: number;
  /** Eligible members of this tier's group when voting closed. */
  eligible: number;
  counts: Record<string, number>;
}

export interface Snapshot {
  /** Hours since voting opened. */
  hour: number;
  label: string;
  ballots: Record<TierKey, number>;
}

export interface Region {
  key: string;
  name: string;
  /** Tier 2 ballots; regions under the floor fold into "Other regions". */
  ballots: number;
  yesShare: number;
}

export interface Election {
  id: string;
  slug: string;
  title: string;
  question: string;
  kind: "Referendum" | "Open poll" | "Organisational vote";
  method: "Plurality" | "Approval" | "Ranked choice";
  scope: string;
  status: "Open" | "Closed" | "Counted" | "Scheduled";
  opens: string;
  closes: string;
  definitionHash: string;
  boardHead: string;
  entries: number;
  options: readonly Option[];
  results: readonly TierResult[];
  timeline: readonly Snapshot[];
  regions: readonly Region[];
}

export const LEVY: Election = {
  id: "b0f70f97076d5a1ad14ad276cc6c9114f4129fead79fc78fdc78bb3eaf5e2647",
  slug: "alder-county-library-levy",
  title: "Alder County library levy",
  question:
    "Should Alder County renew the 0.2% library levy for another ten years, funding the county's 14 branch libraries?",
  kind: "Referendum",
  method: "Plurality",
  scope: "Residents of Alder County",
  status: "Counted",
  opens: "3 November 2026, 06:00 UTC",
  closes: "3 November 2026, 20:00 UTC",
  definitionHash: "03f6b0046ca591110fdf4f91f0199bc14ab68dafd018eaddfecb94ff838fb5a8",
  boardHead: "b7538bbee73afbe2e0a125c76a28bbbfe109c3589bacb94a2153ac28cbab134d",
  entries: 161_874,
  options: [
    { key: "yes", label: "Yes, renew the levy" },
    { key: "no", label: "No, let it expire" },
  ],
  results: [
    { tier: "tier2", ballots: 40_112, eligible: 71_480, counts: { yes: 23_425, no: 16_687 } },
    { tier: "tier1", ballots: 8_301, eligible: 15_022, counts: { yes: 4_731, no: 3_570 } },
    { tier: "tier0", ballots: 112_950, eligible: 129_310, counts: { yes: 49_698, no: 63_252 } },
  ],
  timeline: [
    { hour: 0, label: "06:00", ballots: { tier2: 0, tier1: 0, tier0: 0 } },
    { hour: 2, label: "08:00", ballots: { tier2: 4_210, tier1: 640, tier0: 9_880 } },
    { hour: 4, label: "10:00", ballots: { tier2: 9_870, tier1: 1_910, tier0: 21_400 } },
    { hour: 6, label: "12:00", ballots: { tier2: 16_020, tier1: 3_350, tier0: 38_900 } },
    { hour: 8, label: "14:00", ballots: { tier2: 22_480, tier1: 4_790, tier0: 61_200 } },
    { hour: 10, label: "16:00", ballots: { tier2: 28_950, tier1: 6_020, tier0: 80_330 } },
    { hour: 12, label: "18:00", ballots: { tier2: 35_610, tier1: 7_380, tier0: 99_870 } },
    { hour: 14, label: "20:00", ballots: { tier2: 40_112, tier1: 8_301, tier0: 112_950 } },
  ],
  regions: [
    { key: "north", name: "North Alder", ballots: 9_812, yesShare: 0.612 },
    { key: "riverside", name: "Riverside", ballots: 7_410, yesShare: 0.641 },
    { key: "east", name: "East Hills", ballots: 6_995, yesShare: 0.523 },
    { key: "harbor", name: "Harbor", ballots: 5_870, yesShare: 0.588 },
    { key: "west", name: "West Plain", ballots: 4_633, yesShare: 0.497 },
    { key: "south", name: "South Fork", ballots: 3_102, yesShare: 0.552 },
    { key: "uplands", name: "Uplands", ballots: 1_440, yesShare: 0.474 },
    { key: "other", name: "Other regions (below the floor of 500)", ballots: 850, yesShare: 0.561 },
  ],
};

export const PARKS: Election = {
  ...LEVY,
  id: "b1a71203bc63c46c88c27d024456c4d70c953a796284a33280b376fabc89c490",
  slug: "riverside-park-improvements",
  title: "Riverside park improvements",
  question: "Which improvements should the Riverside neighbourhood association ask the city for?",
  kind: "Open poll",
  method: "Approval",
  scope: "Anyone with an account",
  status: "Open",
  opens: "1 November 2026, 12:00 UTC",
  closes: "15 November 2026, 12:00 UTC",
  entries: 2_418,
  options: [
    { key: "lights", label: "Better lighting on the river path" },
    { key: "toilets", label: "Public toilets open all year" },
    { key: "courts", label: "Resurfaced basketball courts" },
    { key: "trees", label: "Two hundred new street trees" },
  ],
  results: [],
  timeline: [],
  regions: [],
};

export const TRANSIT: Election = {
  ...LEVY,
  id: "e51f53abd304dcf4723e1cc6eb60350c4467dd85ac0847ef85198c2433b4617b",
  slug: "state-transit-bond",
  title: "Statewide transit bond",
  question: "Should the state issue $4.2 billion in bonds for regional rail and bus rapid transit?",
  kind: "Referendum",
  method: "Plurality",
  scope: "Residents of the state, 18 and over",
  status: "Scheduled",
  opens: "8 December 2026, 06:00 UTC",
  closes: "8 December 2026, 22:00 UTC",
  entries: 0,
  options: [
    { key: "yes", label: "Yes" },
    { key: "no", label: "No" },
  ],
  results: [],
  timeline: [],
  regions: [],
};

export const COUNCIL: Election = {
  ...LEVY,
  id: "2fde91727a2e0c67edf0ba1c54c8b83c14116b87e267057c03732840019d5508",
  slug: "tenants-union-board",
  title: "Tenants' union board seat",
  question: "Rank the candidates for the open seat on the Harbor Tenants' Union board.",
  kind: "Organisational vote",
  method: "Ranked choice",
  scope: "Members of the Harbor Tenants' Union",
  status: "Closed",
  opens: "20 October 2026, 00:00 UTC",
  closes: "27 October 2026, 00:00 UTC",
  entries: 611,
  options: [
    { key: "okafor", label: "Adaeze Okafor" },
    { key: "lindqvist", label: "Mara Lindqvist" },
    { key: "reyes", label: "Tomás Reyes" },
  ],
  results: [],
  timeline: [],
  regions: [],
};

export const ELECTIONS: readonly Election[] = [LEVY, PARKS, TRANSIT, COUNCIL];

export const RECEIPT = {
  hash: "1bddad592bb3d9a79ed30408fa786fbfaf6f11f091d44f3947d2b471bd8c1a5d",
  entry: 1_203,
  recorded: "3 November 2026, 14:02:12 UTC",
  anchoredAt: "3 November 2026, 15:00 UTC",
  anchorTx: "e015669745eafb8afb5ee8930d0af31747d8b1e0658079db0b322750ec31a20b",
};

export const BOARD_HASHES = [
  "f12f4ca1e8e6c6e3605fc3d380966849c0ea48d6fb9e0b8b136069814c73dc32",
  "5e2d5d1e58e94d7607e0745cd3e612c4a358fc93f37fc5ab1fed8d04bbf7ce77",
  "edda7b47233f9790fcc6d116d0a0c0eac38a5d6e44b7cf0c002c6d30bfa61e74",
  RECEIPT.hash,
  "6e18ec763c0751ffab6eddca795cf9a03b16c59b30cc266b9281a23a55897359",
  "75fd4a268b09c13ab16af6af68987296498cea8f18054d63d7d26a00714f8d33",
  "b7c2e52d90733be990c46f507e7ea3151bba2e1fd656be8695502ce2c5de4cd3",
  "05cf6326adfd4b14809361fa0a8d2b2271f58e707147e94cb8d02b6a05845d69",
  "29fd7f922bf17266ec390af322024daf75fa91133b8fb25049b4dc66723a6308",
  "92d11bcc469c24d37a908c037f5b3caa0f95cb6716e8ae4d357741a7a0d7edb8",
  "7e7768dc6b4b94a8c5df48261195015567ef500557c66a62a9f57e373a98df09",
  "14f026c4a66a5520225e9dc7f3697dea4c3ed6a4208ac57c64a8b57f73c84a20",
] as const;

export const BOARD_ENTRIES = BOARD_HASHES.map((hash, i) => ({
  index: 1_200 + i,
  time: `14:0${Math.floor(i / 2)}:${String(10 + i * 4).padStart(2, "0")} UTC`,
  kind: i === 6 ? "Spoiled ballot" : i === 9 ? "Anchor" : "Ballot",
  hash,
}));

export interface Trustee {
  name: string;
  kind: string;
  jurisdiction: string;
  key: string;
  status: "Online" | "Offline" | "Share published";
}

export const TRUSTEES: readonly Trustee[] = [
  {
    name: "Northfield Library Cooperative",
    kind: "Library",
    jurisdiction: "United States",
    key: "073a1f0fafeeba76",
    status: "Share published",
  },
  {
    name: "Open Ledger Foundation",
    kind: "Non-profit",
    jurisdiction: "Switzerland",
    key: "9a4bc3d13204c2aa",
    status: "Share published",
  },
  {
    name: "Civic Data Clinic, Westbrook Law School",
    kind: "University",
    jurisdiction: "United States",
    key: "b5acec748bba8c00",
    status: "Share published",
  },
  {
    name: "Harbor Press Guild",
    kind: "Journalists' union",
    jurisdiction: "Canada",
    key: "e527fa4c31d3e678",
    status: "Share published",
  },
  {
    name: "League of Plain Counting",
    kind: "Election observers",
    jurisdiction: "Germany",
    key: "1f0fafeeba769a4b",
    status: "Online",
  },
  {
    name: "Mesa Mutual Aid Network",
    kind: "Community group",
    jurisdiction: "United States",
    key: "c3d13204c2aab5ac",
    status: "Offline",
  },
  {
    name: "Fjord Systems Audit",
    kind: "Security auditor",
    jurisdiction: "Norway",
    key: "ec748bba8c00e527",
    status: "Online",
  },
];

export const ENTRY_POINTS = [
  { name: "abolish.us", note: "Primary. A US-administered domain, so not trusted alone." },
  { name: "abolishus.eth", note: "On Ethereum, reached through any IPFS gateway." },
  { name: "abolish.ch", note: "Second domain outside US administration." },
] as const;

export const CLIENT_RELEASE = {
  version: "1.4.0",
  hash: "723b32ae7b2379f360c1f1f2eb64cb4dcbe603f86f764ded7920acf58a7380a3",
  cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
};

export const MODERATION_LOG = [
  {
    at: "2 November 2026, 09:14 UTC",
    poll: "Best pizza in Harbor",
    action: "Delisted",
    reason: "Spam",
    note: "Forty identical polls from one account.",
  },
  {
    at: "31 October 2026, 18:40 UTC",
    poll: "(text withheld)",
    action: "Hidden",
    reason: "Personal data",
    note: "Named a private individual and their address.",
  },
  {
    at: "29 October 2026, 11:02 UTC",
    poll: "Should the council resign",
    action: "Restored",
    reason: "Appeal upheld",
    note: "Delisted in error as a duplicate.",
  },
] as const;
