// Every check of docs/spec/verifier.md, in the spec's order, with its kind
// (Principles: election, admission or report-only). The report lists each
// exactly once, so a check nobody implements is still reported, as
// unverifiable, never left out (8.3; T-36).

/** How a check's outcome bears on the election's verdict (docs/spec/verifier.md, Principles). */
export type CheckKind = "election" | "admission" | "report-only";

export interface CheckSpec {
  readonly id: string;
  readonly kind: CheckKind;
}

const election = (...ids: string[]) => ids.map((id) => ({ id, kind: "election" }) as const);
const admission = (...ids: string[]) => ids.map((id) => ({ id, kind: "admission" }) as const);
const reportOnly = (...ids: string[]) => ids.map((id) => ({ id, kind: "report-only" }) as const);

export const CHECKS: readonly CheckSpec[] = Object.freeze([
  ...reportOnly("1.1"),
  ...election("1.2", "1.3"),
  ...election("2.1", "2.2", "2.3", "2.4", "2.5", "2.6"),
  ...reportOnly("2.7"),
  ...election("2.8"),
  ...election("3.1", "3.2"),
  ...election("4.1", "4.2", "4.3", "4.4", "4.5"),
  ...admission("5.1", "5.2", "5.3", "5.4", "5.5"),
  ...election("5.6"),
  ...admission("5.7"),
  // 6.1's admission part is an admission check and the rest an election
  // check; one row, judged as an election check, since its unverifiability
  // or failure decides the election either way.
  ...election("6.1"),
  ...admission("6.2"),
  ...election("7.1", "7.2", "7.3"),
  ...reportOnly("7.4"),
  ...election("8.1", "8.2", "8.3", "8.4"),
]);
