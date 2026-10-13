// apps/web's own strings. Every locale's catalog has `en-US`'s type, so a
// missing key fails type-checking (@abolishus/ui, i18n).

import type { Message } from "@abolishus/ui";

const enUS = {
  siteName: "Abolish",
  homeTitle: "Ask anything. Anyone can answer. Anyone can check the count.",
  homeLede:
    "Questions big and small, from your street to your county. Every answer is sealed on the voter's own device and posted to a public board, so anyone who downloads the board can count it again.",
  homeBrowse: "Browse polls",
  homeNonBinding: "Non-binding, and run by citizens.",
  homeLookupTitle: "Have a poll's ID?",
  homeListUnavailable:
    "The list of polls couldn't be loaded just now. Every poll still opens by its ID.",
  trustTitle: "Why you can trust a casual poll",
  trustLede:
    "A question about street trees gets the same care as a referendum. Here is what happens to an answer, in four steps.",
  trustLabel: "What happens to an answer",
  trustStep: "Step {step} of {total}",
  trust1Title: "Sealed on your device",
  trust1Body:
    "When you answer, the ballot app seals it on your own device before it goes anywhere. What travels is a locked box, not your answer.",
  trust1Detail:
    "The detail: it is split into shares, each encrypted to one of the poll's trustees.",
  trust2Title: "Put on a public board",
  trust2Body:
    "Every sealed answer goes on a public board that anyone can read. You keep a tracking code, so you can find yours there and see that it was counted.",
  trust2Detail: "The detail: each entry extends a hash chain, so removing or changing one shows.",
  trust3Title: "Opened only after the poll closes",
  trust3Body:
    "The count is unlocked only when enough of the poll's trustees, each holding one share of the key, work together after it closes. No single seat can open it alone. During launch every seat is run by Abolish, so these polls are private from everyone except us. Independent trustees take over before the first civic vote, and askers will be able to add trustees of their own.",
  trust3Detail: "The detail: it takes {threshold} of the {seats} seats.",
  trust4Title: "Counted again by anyone",
  trust4Body:
    "Anyone can take the public board and count it again with the open-source verifier. If their count matches ours, nobody has to take our word for it.",
  trust4Detail: "The detail: the verifier checks every proof as well as the count.",
  graphicAnswer: "Your answer",
  graphicOption: "Yes",
  graphicSealed: "What leaves your device",
  graphicBoard: "The public board",
  graphicYours: "Yours",
  graphicOpen: "To open the count",
  graphicSeats: "{threshold} of {seats} seats",
  graphicPublished: "Published count",
  graphicRecount: "Anyone's recount",
  graphicMatch: "They match.",
  navHowItWorks: "How it works",
  howEyebrow: "How it works · {count} sections",
  howTitle: "How a ballot stays secret, gets recorded and is counted in public",
  howLede:
    "Abolish is built so that you don't have to trust it. This page follows a ballot through every stage, says what each step proves and what it doesn't, and ends with the weaknesses we haven't solved. Abolish is still being built: where a step isn't running yet, it says so.",
  howContents: "On this page",
  howStep: "Step {step}",
  howSceneLabel: "{section}, step by step",
  howTiersMark: "Who can vote",
  howTiersTitle: "Who is counted, and how sure we are",
  howTiersIntro:
    "Abolish can't check everyone the same way, so every result says how its voters were checked, with one result per tier. Tiers are never added together.",
  howTiers1Title: "Tier 0: a passkey",
  howTiers1Body:
    "Anyone can create an account with a passkey, and anyone can create several. A Tier 0 result counts accounts, not people, and says so. Today's polls run at Tier 0.",
  howTiers2Title: "Tier 1: vouched for (planned)",
  howTiers2Body:
    "People who are already verified will be able to vouch for someone, so faking a voter needs accomplices willing to put their own standing behind it. This tier is being built.",
  howTiers3Title: "Tier 2: a government document (planned)",
  howTiers3Body:
    "A voter will prove on their own phone, with a zero-knowledge proof, that they hold a government-signed passport or ID with a readable chip. The proof shows neither the document nor the person, only that the same document hasn't been used to join twice. This tier is being built.",
  howTiers4Title: "Side by side, never summed",
  howTiers4Body:
    "Each tier's result is reported on its own, with its number of ballots and who could vote. One blended figure would mostly report whoever opened the most accounts.",
  howSecrecyMark: "Ballot secrecy",
  howSecrecyTitle: "Your choice is sealed on your own device",
  howSecrecyIntro:
    "Secrecy doesn't rest on this website behaving. The ballot app seals your choice on the device that shows it to you, before anything is sent.",
  howSecrecy1Title: "You choose in the ballot app",
  howSecrecy1Body:
    "Ballots are cast only in the ballot app, never on this website. It shows the question and options exactly as the poll's published definition fixes them, and your choice stays in your device's memory.",
  howSecrecy2Title: "Your choice is locked in a commitment",
  howSecrecy2Body:
    "The app turns your choice into a commitment: a value that fixes the choice but hides it completely, whatever computing power arrives later. The commitment is what goes on the public board.",
  howSecrecy3Title: "The key to it is split between trustees",
  howSecrecy3Body:
    "The numbers that open the commitment are split into shares, one for each trustee seat, and each share is encrypted to its seat alone, with encryption meant to hold against future quantum computers as well as today's. No single seat can open a ballot. During launch every seat is run by Abolish, so these ballots are private from everyone except us (section 5).",
  howSecrecy4Title: "With proofs that it is a valid vote",
  howSecrecy4Body:
    "The app attaches zero-knowledge proofs that the commitment holds an allowed answer, so a ballot can't carry a hundred votes or a negative one, and that the voter belongs to the poll's electorate, without saying which answer or which member. Your account is never part of the ballot.",
  howChallengeMark: "Cast as intended",
  howChallengeTitle: "Checking that the app sealed what you chose",
  howChallengeIntro:
    "No one can see inside a sealed ballot, including you. A check lets you open one and see what the app really sealed, at the cost of that ballot.",
  howChallenge1Title: "The app seals first, then asks",
  howChallenge1Body:
    "After sealing your choice, the app asks whether to cast the ballot or check it. It has already committed to the sealed ballot before it knows which you will pick.",
  howChallenge2Title: "Checking opens the ballot",
  howChallenge2Body:
    "If you check, the app reveals the choice and every random number it used, so the sealed ballot can be rebuilt from them and compared. A checked ballot is never counted.",
  howChallenge3Title: "Then you vote again",
  howChallenge3Body:
    "The app seals your choice afresh, with new random numbers, and asks again. You can check as many times as you like before you cast.",
  howChallenge4Title: "Why a cheating app gets caught",
  howChallenge4Body:
    "An app that changed votes can't tell which ballots will be checked, so every check is a chance to catch it. Few voters check, so this protection is statistical. Publishing a checked ballot's opening is your choice, off by default, and happens only after the poll closes.",
  howRecordedMark: "Recorded as cast",
  howRecordedTitle: "Finding your ballot on the public board",
  howRecordedIntro:
    "Each poll has a public board that only ever grows. Your receipt names the entry that holds your sealed ballot, so you can check that it is there and stays there.",
  howRecorded1Title: "Every ballot becomes an entry",
  howRecorded1Body:
    "Each sealed ballot is added to the poll's board as a numbered entry. Every entry extends a hash chain and a Merkle tree, so changing or removing an earlier one shows.",
  howRecorded2Title: "You keep a receipt",
  howRecorded2Body:
    "When your ballot is added, the board's operator signs a receipt naming its entry and the board that holds it. The app checks that the entry is really in that board before telling you the ballot was received, and keeps the receipt.",
  howRecorded3Title: "It proves recording, not your choice",
  howRecorded3Body:
    "With the receipt and a short inclusion proof, anyone can check that a later board still holds your entry. The receipt says nothing about how you voted, so it isn't proof of a vote. Keep it to yourself, though: it points to your ballot on the board, so whoever sees it can spot any later ballot you cast in the same poll.",
  howRecorded4Title: "Anchored on Ethereum (planned)",
  howRecorded4Body:
    "Every hour, the board's root will be anchored on Ethereum. A receipted entry missing from a later anchored board is evidence of tampering that anyone can publish. Hourly anchoring isn't running yet.",
  howCountedMark: "Counted as recorded",
  howCountedTitle: "Counting without opening a single ballot",
  howCountedIntro:
    "The count is arithmetic on sealed ballots. Trustees open only the totals, and every step publishes something anyone can check.",
  howCounted1Title: "Commitments add up",
  howCounted1Body:
    "Commitments can be added together without being opened. Adding every counted ballot's commitment gives one sealed total for each tier.",
  howCounted2Title: "Each seat sums its shares",
  howCounted2Body:
    "After the poll closes, each trustee seat adds up the shares it received and publishes the sum. Anyone can check each sum against public values the ballots carried, so a seat can't publish a wrong one unnoticed.",
  howCounted3Title: "{threshold} of {seats} seats open the totals",
  howCounted3Body:
    "Once {threshold} of the {seats} seats have published, their sums open each tier's total, and only the totals: no single ballot is opened. During launch all {seats} seats are run by Abolish. Independent trustees take over before the first civic vote, and askers will be able to add trustees of their own.",
  howCounted4Title: "Anyone can count again",
  howCounted4Body:
    "The open-source verifier takes the public board and checks every proof, every sum and the count. If its result matches ours, no one has to take our word for it. Afterwards the seats destroy their keys and shares, though no one can verify that they did.",
  howSurvivesMark: "If abolish.us is taken down",
  howSurvivesTitle: "What survives without us",
  howSurvivesIntro:
    "A record that disappears with its publisher isn't much of a record. These pieces are meant to let voting, the board and the count outlast our domain, our servers and us. Most of them are still being built.",
  howSurvives1Title: "Polls registered on chain (planned)",
  howSurvives1Body:
    "Each poll's definition hash and its trustees' keys will be registered on an Ethereum layer 2 network, so a poll's rules can't be swapped after it opens.",
  howSurvives2Title: "Submitting without us (planned)",
  howSurvives2Body:
    "If our servers refuse a ballot, the ballot app will be able to post it straight to the contracts, bypassing us entirely.",
  howSurvives3Title: "Copies of the board (planned)",
  howSurvives3Body:
    "The board will be mirrored to IPFS and a permanent archive, its root anchored on Ethereum, and anyone will be able to run a lightweight node that serves it.",
  howSurvives4Title: "A verifier that needs none of us (planned)",
  howSurvives4Body:
    "The verifier will work from the chain and IPFS alone, with our servers and domain offline. Wiping our database loses no result: everything that affects one can be rebuilt from the public copies.",
  howWeakMark: "What remains open",
  howWeakTitle: "Where it is weak, stated plainly",
  howWeakIntro:
    "No voting system is safe against everything. These are the limits we know of today. Where a limit has an entry in our public threat model, its number is beside it, and this list changes as they do.",
  howWeakLimit: "What limits it:",
  howWeakThreats: "Threat model entries:",
  howWeakPanelTitle: "During launch, we hold every trustee seat",
  howWeakPanelMeans:
    "Abolish runs every seat of the launch panel, so we could open any single ballot, and anyone who can compel us could make us.",
  howWeakPanelLimit:
    "An opened ballot shows what one anonymous voting identity answered, not who it is, unless it is joined to the network address the ballot came from (see the limit on addresses below). Independent trustees take over before the first civic vote, but polls opened before then stay readable with our shares until we destroy them, which no one can verify.",
  howWeakSybilTitle: "Tier 0 can be faked at scale",
  howWeakSybilMeans:
    "Anyone can create many passkey accounts. A Tier 0 result describes what accounts said, not what people think.",
  howWeakSybilLimit:
    "It is always reported on its own and labelled as such, never blended into a total.",
  howWeakWatchTitle: "Someone can watch you vote",
  howWeakWatchMeans:
    "A receipt proves your ballot was recorded, not your choice. But nothing stops someone standing over your screen, or demanding your receipt.",
  howWeakWatchLimit:
    "You can vote again later and only your last ballot counts, so a vote someone watched needn't be your final one. But anyone who has seen your receipt can see that you voted again, and selling a vote in secret isn't prevented. That is a partial defence, not a cure.",
  howWeakColludeTitle: "Trustees could collude",
  howWeakColludeMeans:
    "Any group of seats that meets a poll's threshold, acting together, could open single ballots, not only totals.",
  howWeakColludeLimit:
    "Every sum a seat publishes is public and checked, and each poll's page says how many seats it takes.",
  howWeakDeviceTitle: "A compromised device",
  howWeakDeviceMeans: "Malware on a voter's device could change a choice before it is sealed.",
  howWeakDeviceLimit:
    "Checks catch a cheating app, but only if people use them. Most voters won't, so the protection is statistical.",
  howWeakAnchorTitle: "Before the board is anchored",
  howWeakAnchorMeans:
    "Until a board's root is anchored on Ethereum, the board is only our word, and an entry could be dropped.",
  howWeakAnchorLimit:
    "Keep your receipt: a later board that leaves out a receipted entry is evidence anyone can publish. Hourly anchoring isn't running yet.",
  howWeakNetworkTitle: "We see where a ballot comes from",
  howWeakNetworkMeans:
    "Our servers receive each ballot with the network address it was sent from, which could help link a ballot to a person.",
  howWeakNetworkLimit:
    "Not mitigated. Our API's own request log leaves addresses out on the ballot path, but our hosting provider and the network edge in front of it may still see or record them, and the trustee seats receive each ballot with its address. You can't check what we keep: a VPN or Tor hides your address from us.",
  howWeakTurnoutTitle: "Turnout is self-selected",
  howWeakTurnoutMeans:
    "Voters choose to take part, so a result describes who answered, not everyone. Results are advisory and bind no one.",
  howWeakTurnoutLimit: "Every result carries its tier and how many could vote.",
  howSource:
    "The protocol, its threat model (with every entry named above) and the source code are published in the open at github.com/abolishus/abolish.",
  dgTitle: "{section}: step {step} of {total}",
  dgFake: "To fake one",
  dgFake0: "another passkey",
  dgFake1: "people willing to vouch falsely",
  dgFake2: "a forged government document",
  dgPlanned: "Planned",
  dgToday: "Today",
  dgResult: "Its own result",
  dgNoTotal: "No total row.",
  dgDevice: "Your device",
  dgLeaves: "What leaves it",
  dgChoice: "Your choice",
  dgCommitment: "Commitment",
  dgShares: "A share for each seat",
  dgProofs: "Validity proofs",
  dgToBoard: "To the public board",
  dgToSeats: "Each to its own seat, encrypted",
  dgSealed: "Sealed ballot",
  dgCast: "Cast",
  dgCheck: "Check",
  dgOpened: "Opened: choice and random numbers",
  dgRebuilt: "Rebuilt and compared",
  dgNotCounted: "Never counted",
  dgSealedAgain: "Sealed again, new random numbers",
  dgChecked: "Checked",
  dgEntry: "Entry {index}",
  dgYours: "Yours",
  dgReceipt: "Your receipt",
  dgReceiptEntry: "Entry and board, signed",
  dgInclusion: "Inclusion proof",
  dgStillThere: "Still on the board",
  dgAnchor: "Root anchored on Ethereum",
  dgSum: "Sum",
  dgTotal: "Sealed total for each tier",
  dgOurs: "During launch, all run by Abolish",
  dgDomain: "abolish.us",
  dgServers: "Our servers",
  dgRegistry: "Poll registry on layer 2",
  dgDirect: "Ballots sent straight to the contracts",
  dgMirrors: "IPFS, archive and community nodes",
  dgAnchors: "Anchors on Ethereum",
  dgVerifier: "The verifier",
  dgDown: "Offline",
  lookupLabel: "Poll ID",
  lookupHint: "The 64-character ID from a poll link or a receipt.",
  lookupSubmit: "Open poll",
  lookupInvalid: "A poll ID is 64 hexadecimal characters (0–9, a–f).",
  navModeration: "Moderation log",
  navPolls: "Polls",
  listTitle: "Listed polls",
  listLede:
    "Polls this server lists, in order of their IDs. Polls that moderation has delisted or hidden aren't listed but stay open by ID, and the election registry on chain names every poll, whatever this list shows.",
  listEmpty: "No polls listed.",
  listCloses: "Closes",
  listIllFormed: "Breaks a protocol rule: the verifier fails it.",
  listMore: "More polls",
  listUndecodable: "The server's definition doesn't decode.",
  listMismatch: "The server sent another poll's definition.",
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
  factShortLink: "Short link",
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
    "This definition breaks a protocol rule ({rule}), so the verifier fails this election.",
  "rule_protocol-major": "unsupported protocol version",
  "rule_profile-order": "record versions out of order",
  "rule_profile-types": "wrong record types",
  "rule_profile-version": "a record at version 0",
  "rule_option-count": "number of options",
  rule_selections: "selection limits",
  rule_electorate: "who can vote",
  rule_panel: "trustee panel",
  rule_chain: "chains and contracts",
  rule_timing: "opening and closing times",
  utcTime: "{time} UTC",
  shortId: "{prefix}…",
  moderationDelisted:
    "This poll is left out of discovery and search ({reason}). Its board and result are unaffected.",
  moderationHidden:
    "This poll's question and option text are withheld ({reason}). Its board and result are unaffected, shown by option number.",
  moderationLogLink: "See the moderation log",
  siteTagline: "Ask anything. Check everything.",
  skipToContent: "Skip to content",
  navSite: "Site",
  navHome: "Home",
  navPollsNote: "Every poll this server lists",
  navModerationNote: "Every moderation decision, with its reason",
  navHomeNote: "Start again from the front page",
  footerClaim: "Non-binding, run by citizens, and every count can be checked.",
  footerRecord: "Every poll here is on a public board that anyone can download and count again.",
  footerNav: "The record",
  otherPlaces: "Other places to go",
  notFoundCode: "404 · Not found",
  notFoundTitle: "There is no page at this address",
  notFound:
    "The link may be mistyped, or the page may have moved. Nothing on the record is ever removed: board entries, definitions and results are permanent.",
  notFoundPoll:
    "If you were looking for a poll, paste its 64-character ID into the form on the front page.",
  unavailableTitle: "Poll unavailable",
  definitionUndecodable:
    "The server sent a definition that doesn't decode under the protocol, so this page won't show it.",
  definitionMismatch:
    "The server sent the definition of another poll for this ID, so this page won't show it.",
  errorCode: "Error",
  errorTitle: "Something went wrong on our side",
  error:
    "This page couldn't be shown. Try again in a moment, or go somewhere else below. This website never handles ballots: if you were voting, your ballot and receipt are safe in the ballot app on your device.",
  errorRetry: "Try again",
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
  navAccount: "Account",
  accountTitle: "Account",
  accountLede:
    "An account lets you create and manage polls. It never votes: ballots are cast in the ballot app, with a voting identity that stays on your device, and nothing here can tell how or whether you voted.",
  accountNeedsScript: "Accounts use passkeys, which need this page's script.",
  accountSignUp: "Create an account with a passkey",
  accountSignIn: "Sign in with a passkey",
  accountSignedIn: "You're signed in.",
  accountSignOut: "Sign out",
  accountSignOutOthers: "Sign out everywhere else",
  signedIn: "You're signed in.",
  signedOut: "You're signed out.",
  accountDeleted: "The account is deleted.",
  passkeyRemoved: "Passkey removed.",
  signedOutOthers: "Every other session of this account is signed out.",
  passkeysTitle: "Passkeys",
  passkeySynced: "Synced passkey, added {created} UTC",
  passkeyDevice: "Device passkey, added {created} UTC",
  passkeyRemove: "Remove",
  passkeyAdd: "Add a passkey",
  passkeyAdded: "Passkey added.",
  accountDeleteTitle: "Delete account",
  accountDeleteLede:
    "Deletes the account, its passkeys and its sessions. Polls already published stay on the public board.",
  accountDelete: "Delete account…",
  accountDeleteConfirm: "Delete account permanently",
  accountDeleteCancel: "Keep account",
  accountFailure_cancelled: "The passkey prompt was dismissed. Nothing changed.",
  accountFailure_unsupported: "This browser doesn't support passkeys.",
  accountFailure_failedSignedOut: "That didn't work. Nothing changed; try again shortly.",
  accountFailure_failed:
    "That didn't work. Adding a passkey or deleting the account needs a sign-in from the last day: sign out, sign in again and retry.",
} as const;

export type Messages = Record<keyof typeof enUS, Message>;

export const catalogs: Readonly<Record<string, Messages>> = { "en-US": enUS };

export const LOCALE = "en-US";
