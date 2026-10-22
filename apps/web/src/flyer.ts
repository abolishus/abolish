// The flyer's papers and inks, apart from its component
// (src/components/poll-flyer.tsx) so the flyer's route reads them without
// bringing the flyer's script into every page's (P2-28 part 2b).

export type Paper = "letter" | "a4";
export type Ink = "color" | "mono";

export const PAPERS = ["letter", "a4"] as const satisfies readonly Paper[];
export const INKS = ["color", "mono"] as const satisfies readonly Ink[];
