// apps/web's own strings. Every locale's catalog has `en-US`'s type, so a
// missing key fails type-checking (@abolishus/ui, i18n).

import type { Message } from "@abolishus/ui";

const enUS = {
  siteName: "Abolish",
  homeTitle: "Public polls you can check yourself",
  homeLede:
    "Every ballot is encrypted on the voter's device and posted to a public board. Anyone can recount a result from the board and the chain, without trusting us.",
  lookupLabel: "Poll ID",
  lookupHint: "The 64-character ID from a poll link or a receipt.",
  lookupSubmit: "Open poll",
  lookupInvalid: "A poll ID is 64 hexadecimal characters (0–9, a–f).",
  navModeration: "Moderation log",
  pollTitle: "Poll",
  pollId: "Poll ID",
  pollClaim:
    "Everything below is what our server says about this poll. The verifier checks it against the chain; this page doesn't.",
  definitionHash: "Definition hash, to compare with the election registry on chain",
  factType: "Counting",
  typePlurality: "One choice",
  typeApproval: "Approve any number",
  factOptions: "Options",
  factSelections: "Selections per ballot",
  selectionsRange: "{min} to {max}",
  factTrustees: "Trustees needed to decrypt the tally",
  trusteesOf: "{threshold} of {size}",
  factOpens: "Opens",
  factCloses: "Closes",
  factElectorate: "Who can vote",
  tier0: "Tier 0 (passkey)",
  tier1: "Tier 1 (vouched)",
  tier2: "Tier 2 (document-verified)",
  groupMembers: { one: "{count} member", other: "{count} members" },
  boardTitle: "Public board",
  boardEntries: "Entries",
  boardEmpty: "No entries yet.",
  boardHead: "Chain head",
  boardRoot: "Tree root",
  boardUnanchored:
    "Until an L1 checkpoint covers these values, they are only this server's word. Keep them: a later board that doesn't extend them is evidence of tampering.",
  illFormed:
    "This definition breaks the protocol's rule “{rule}”, so the verifier fails this election.",
  moderationDelisted:
    "This poll is left out of discovery and search ({reason}). Its board and result are unaffected.",
  moderationHidden:
    "This poll's question and option text are withheld ({reason}). Its board and result are unaffected, shown by option number.",
  moderationLogLink: "See the moderation log",
  notFoundTitle: "Not found",
  notFound: "This server knows no poll or page at this address.",
  unavailableTitle: "Poll unavailable",
  definitionUndecodable:
    "The server sent a definition that doesn't decode under the protocol, so this page won't show it.",
  definitionMismatch:
    "The server sent the definition of another poll for this ID, so this page won't show it.",
  errorTitle: "Something went wrong",
  error: "This page couldn't be shown. Try again shortly.",
  moderationTitle: "Moderation log",
  moderationLede:
    "Every moderation decision we make, oldest first, with its reason. Moderation only changes how a poll is listed or whether its text is shown, never its board, its definition or its result.",
  moderationEmpty: "No decisions yet.",
  moderationSeq: "No.",
  moderationPoll: "Poll",
  moderationAction: "Action",
  moderationReason: "Reason",
  moderationDecided: "Decided (UTC)",
  moderationMore: "Later decisions",
  action_delist: "Delisted",
  action_hide: "Text hidden",
  action_restore: "Restored",
  reason_illegal: "Illegal content",
  "reason_personal-data": "Personal data",
  reason_threat: "Threat",
  reason_harassment: "Harassment",
  reason_spam: "Spam",
  reason_impersonation: "Impersonation",
  "reason_legal-notice": "Legal notice",
  "reason_appeal-upheld": "Appeal upheld",
  reason_error: "Moderator error",
  "reason_notice-withdrawn": "Notice withdrawn",
} as const;

export type Messages = Record<keyof typeof enUS, Message>;

export const catalogs: Readonly<Record<string, Messages>> = { "en-US": enUS };

export const LOCALE = "en-US";
