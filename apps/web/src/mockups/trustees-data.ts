// Sample data for the Trustees mockup (Storybook only). Every trustee, key,
// time and transcript entry is invented.

import { TRUSTEES, type Trustee } from "./fixtures.ts";

const KEY_TAILS = [
  "bf385ed46919b2d12d1271f2127a0bc464ae6f214927e397",
  "7d6c18a15e7f7a516e4fc53f254c4e2a5e31b9003ca7e460",
  "9abf4bf101529bc0df81cc63626d12c874305fa916bdeb1d",
  "a1882dc0787432a814ab87fa48acc0de1dcc103a2eb0ea24",
  "32ec43f60bf75b212465a0930e4cfdb8412bec4014cf2338",
  "0d56abe81ddfff6ae1ba63e6d401f626724d9e28f36223fe",
  "6d676f276d573428de94f088d05711af3c54642ea3b7767a",
] as const;

export interface TrusteeRecord extends Trustee {
  /** "T1" … "T7", the trustee's seat in the ceremony. */
  seat: string;
  /** The trustee's public key commitment, 32 bytes as hex. */
  publicKey: string;
  /** When its commitment was published at the key ceremony. */
  committedAt: string;
}

export const TRUSTEE_RECORDS: readonly TrusteeRecord[] = TRUSTEES.map((t, i) => ({
  ...t,
  seat: `T${i + 1}`,
  publicKey: `${t.key}${KEY_TAILS[i] ?? KEY_TAILS[0]}`,
  committedAt: `15:0${i + 1}:${String(12 + i * 7).padStart(2, "0")} UTC`,
}));

export const THRESHOLD = 4;

export const JOINT_KEY = "ecfb21b36a92b1cccff8a7d1bb0c85ba16f703d902f93d6059c7195ce0bbcfd2";
export const CEREMONY_CID = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
export const CEREMONY_ANCHOR_TX =
  "f608d163709677409c547c7a4ac9c80362045492cc26acd0f8d4957fba1e572e";

export interface CeremonyEntry {
  entry: number;
  time: string;
  event: string;
  detail: string;
  hash?: string;
  seat?: string;
}

export const CEREMONY: readonly CeremonyEntry[] = [
  {
    entry: 1,
    time: "15:00:00 UTC",
    event: "Ceremony opened",
    detail: "Parameters published: 7 trustees, threshold 4. Observed in person and streamed.",
  },
  ...TRUSTEE_RECORDS.map((t, i) => ({
    entry: i + 2,
    time: t.committedAt,
    event: "Commitment published",
    detail: t.name,
    hash: t.publicKey,
    seat: t.seat,
  })),
  {
    entry: 9,
    time: "15:22:40 UTC",
    event: "Shares exchanged",
    detail: "42 encrypted shares, one from each trustee to each other. Every share checked.",
  },
  {
    entry: 10,
    time: "15:31:05 UTC",
    event: "Complaints window closed",
    detail: "No complaints filed. No trustee disqualified.",
  },
  {
    entry: 11,
    time: "15:33:18 UTC",
    event: "Joint public key published",
    detail: "Recorded on the L2 and on the board. Ballots are encrypted to this key.",
    hash: JOINT_KEY,
  },
];

export interface ShareArrival {
  seat: string;
  time: string;
}

/** The order shares arrived for the Alder County levy tally, 3 November 2026. */
export const ARRIVALS: readonly ShareArrival[] = [
  { seat: "T1", time: "20:04 UTC" },
  { seat: "T2", time: "20:09 UTC" },
  { seat: "T3", time: "20:11 UTC" },
  { seat: "T4", time: "20:17 UTC" },
];

export const OFFLINE_SEATS = ["T6", "T7"] as const;

export interface Jurisdiction {
  name: string;
  seats: readonly string[];
  legal: string;
}

export const JURISDICTIONS: readonly Jurisdiction[] = [
  { name: "United States", seats: ["T1", "T3", "T6"], legal: "Three trustees, three states" },
  { name: "Switzerland", seats: ["T2"], legal: "Foundation under Swiss law" },
  { name: "Canada", seats: ["T4"], legal: "Union registered in Ontario" },
  { name: "Germany", seats: ["T5"], legal: "Registered association" },
  { name: "Norway", seats: ["T7"], legal: "Limited company" },
];
