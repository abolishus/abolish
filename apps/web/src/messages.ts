// apps/web's own strings. Every locale's catalog has `en-US`'s type, so a
// missing key fails type-checking (@abolishus/ui, i18n).

import type { PollTopic } from "@abolishus/core/poll-topics";
import type { PollFailure } from "@abolishus/core/poll-failures";
import type { Message } from "@abolishus/ui";

import type { Locale } from "./locales.ts";
import type { Tier } from "./poll.ts";

const enUS = {
  siteName: "Abolish",
  homeTitle: "Ask anything. Anyone can answer. Anyone can check the count.",
  homeLede:
    "For your friends, your street, your club or your class. Every count is public, so nobody has to take anyone's word for the result.",
  homeAsk: "Ask a question",
  homeBrowse: "Browse questions",
  appDescription: "Ask anything. Anyone can answer. Anyone can check the count.",
  homeNonBinding: "Non-binding, and run by citizens.",
  homeStreamTitle: "What people are asking",
  homeStreamLede: "The newest open questions.",
  homeStreamPick:
    "Choose an answer on any card to open it in the ballot app. Nothing is sent until you cast your ballot there.",
  homeStreamAll: "See all questions",
  homeStreamEmpty: "No questions are open just now. When someone asks one, it shows up here.",
  homeListUnavailable:
    "The newest questions couldn't be loaded just now. Try again in a little while.",
  trustTitle: "Why you can trust a casual poll",
  trustLede:
    "A question about street trees is sealed, posted and counted the same way as a referendum. Here is what happens to an answer, in four steps.",
  trustLabel: "What happens to an answer",
  trustStep: "Step {step} of {total}",
  trust1Title: "Sealed on your device",
  trust1Body:
    "When you answer, the ballot app seals it on your own device before it goes anywhere. What travels is a locked box, not your answer.",
  trust1Detail:
    "The detail: it is split into shares, each encrypted to one of the poll's trustee seats.",
  trust2Title: "Put on a public board",
  trust2Body:
    "Every sealed answer goes on a public board that anyone can read. You keep a tracking code, so you can find yours there and see that it stays there.",
  trust2Detail: "The detail: each entry extends a hash chain, so removing or changing one shows.",
  trust3Title: "Opened only after the poll closes",
  trust3Body:
    "The count is unlocked only when enough of the poll's trustee seats, each holding one share of every sealed answer, work together after it closes. No single seat can open it alone. During launch every seat is run by Abolish, so these polls are private from everyone except us. Independent trustees take over before the first civic vote, and askers will be able to add trustees of their own.",
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
  navDiscover: "Discover",
  discoverTitle: "What people are asking",
  discoverLede:
    "Open questions from neighbours, groups and schools. Answer any of them in the ballot app. Nothing here is ranked by clicks, by arguments or by anything about you: every order below is the same for everyone.",
  discoverTopicLede:
    "Open questions their askers filed under this topic. Nothing here is ranked by clicks, by arguments or by anything about you.",
  discoverSorts: "Order",
  discoverTopics: "Topics",
  topicAll: "All topics",
  sort_new: "New",
  sort_closing: "Closing soon",
  sort_answered: "Most answered this week",
  sortNote_new: "Open now, the most recently asked first.",
  sortNote_closing: "Open now, the soonest to close first.",
  sortNote_answered:
    "Open now, by how many people answered in the last seven days, each person once however often they changed their answer. Anyone can count it again from the public board.",
  streamQuestions: "Questions",
  streamCloses: "Closes",
  streamPick: {
    one: "Choose an answer to open it in the ballot app. Nothing is sent until you cast your ballot there.",
    other:
      "Choose an answer to question 1 of {count} to open it in the ballot app. Nothing is sent until you cast your ballot there.",
  },
  streamPickFirst: "These answers are for question 1 of {count}.",
  streamNoBallot: "Answering from this page isn't set up on this site yet.",
  streamText: "This poll's text can't be shown here. Its page has what this server holds.",
  streamEmpty: "No open questions just now",
  streamEmptyLede: "When someone asks one, it shows up here.",
  streamMore: "More questions",
  streamSortUnavailableTitle: "This order isn't available just now",
  streamSortUnavailable:
    "The server can't count this week's answers at the moment. The other orders still work.",
  streamCursorLostTitle: "That page has moved on",
  streamCursorLost: "The question this page started after can't be placed in this order any more.",
  streamStart: "Start from the top",
  streamSearchLabel: "Search the questions",
  streamSearchHint:
    "Every word you type must appear in a question or its title, up to {words} words. Results keep the order above.",
  streamSearchSubmit: "Search",
  streamSearching: "Only the questions that hold every word you searched for.",
  streamSearchClear: "Clear the search",
  streamSearchEmpty: "No open question matches",
  streamSearchEmptyLede:
    "Try fewer words, or shorter ones: a question matches only when it holds every one.",
  streamSearchRefusedTitle: "That search can't be run",
  streamSearchRefused: "A search is one to {words} words, in at most {characters} characters.",
  listedUnder: "Where it's listed",
  streamTagsNote:
    "Askers choose their poll's topic and place. They aren't part of the poll, and moderation can change them if they don't fit.",
  streamPlaceLabel: "Place",
  streamPlaceHint:
    "A town, neighbourhood or school, as askers write it. Capitals and spacing don't matter, but the whole name must match.",
  streamPlaceFiltering: "Only the questions filed at the place you entered.",
  streamPlaceClear: "Clear the place",
  streamFilterEmpty: "No open question is filed here",
  streamFilterEmptyLede:
    "Only polls whose askers chose this topic or place are listed. Try without one of them.",
  streamShowEverything: "Show everything",
  streamPlaceRefusedTitle: "That place can't be looked up",
  streamPlaceRefused: "A place is one to {characters} characters, as an asker would write it.",
  listTitle: "Listed polls",
  listLede:
    "Polls this server lists, in order of their IDs. Polls that moderation has delisted or hidden aren't listed but stay open by ID, and the election registry on chain names every poll, whatever this list shows.",
  listEmpty: "No polls listed.",
  listCloses: "Closes",
  listIllFormed: "Breaks a protocol rule: the verifier fails it.",
  listMore: "More polls",
  listUndecodable: "The server's definition doesn't decode.",
  listMismatch: "The server sent another poll's definition.",
  listOpens: "Opens",
  listClosed: "On",
  listPoll: "Poll",
  listCounting: "Counting",
  listStatus: "Status",
  fingerprintPoll: "Fingerprint of poll {prefix}",
  status_open: "Open",
  status_scheduled: "Scheduled",
  status_closed: "Closed",
  registerEyebrow: "Register of polls",
  registerTitle: "Every listed poll",
  registerLookupTitle: "Open a poll by its ID",
  registerFindTitle: "Find a poll",
  registerFindLede:
    "Filter this page of the list by status and counting rule. Leave a group at All to include all of it.",
  registerAsOf:
    "Statuses come from each poll's stated opening and closing times, read against this server's clock ({time} UTC).",
  filterAll: "All",
  filterApply: "Show matching polls",
  filterClear: "Clear filters",
  registerMatches: "{shown} of {total} polls on this page match.",
  registerNoMatchTitle: "No polls on this page match",
  registerNoMatch:
    "Nothing on this page of the list matches these filters. A poll that moderation has delisted isn't listed, but it stays open by its ID, and the election registry on chain still names it.",
  pollTitle: "Poll",
  pollHeading: "Poll {prefix}…",
  pollStatus_open: "Open for answers",
  pollStatus_scheduled: "Not open yet",
  pollStatus_closed: "Closed",
  pollAnswerTitle: "Answering",
  pollAnswer:
    "Answers are cast only in the ballot app, never on this website, and each is sealed on the voter's own device before anything is sent. The ballot app can't open a poll from this page yet.",
  pollAnswerClosed: "This poll has closed. Its board stays public, so anyone can count it again.",
  reactionsTitle: "Reactions",
  reactionsLede:
    "React to the poll itself, whether or not you answer it. A reaction isn't an answer and says nothing about whether you answered.",
  reactionsLabel: "Reactions to this poll",
  reaction_heart: "Heart",
  reaction_laugh: "Laugh",
  reaction_wow: "Wow",
  reaction_thinking: "Thinking",
  reaction_sad: "Sad",
  reaction_clap: "Clap",
  reactionCount: { one: "{name}: {count} person", other: "{name}: {count} people" },
  reactionsLoading: "Loading reactions…",
  reactionsPrivacy: "Anyone can see the counts. Only you can see which reactions are yours.",
  reactionsJoin: "React to this poll",
  reactionsSignIn: "Sign in",
  reactionsSignedOut: "Reacting needs a signed-in account.",
  reactionsVerify: "Verify your e-mail",
  reactionsUnverified: "Reacting needs a verified e-mail address.",
  reactionsHidden: "This poll is hidden, so its reactions are too.",
  reactionsTooManyThisHour:
    "You've changed your reactions as often as you can this hour. Try again later.",
  reactionsFailed: "That didn't go through. Try again shortly.",
  reactionsUnread: "Reactions couldn't be loaded just now.",
  shareOpen: "Share this poll",
  shareNeverYourAnswer:
    "Sharing sends this link, never your answer. The link is the same for everyone, so it doesn't say who shared it or whether they answered.",
  shareLinkLabel: "Link to this poll",
  shareCopy: "Copy link",
  shareCopied: "Link copied",
  shareCopiedStatus: "Link copied. Paste it anywhere.",
  shareCopyFailed: "Couldn't copy. Select the link above and copy it.",
  shareMenu: "Share…",
  shareNoMenu:
    "This browser doesn't have a share menu. Copy the link and paste it where you like, or email it.",
  shareEmail: "Email the link",
  shareQrShow: "Show a QR code",
  shareQrLabel: "QR code for {link}",
  shareQrNote:
    "Point a phone's camera at it to open this poll. It holds the same link, so it says nothing about who showed it.",
  shareFlyer: "Print a flyer",
  shareEmbed: "Embed on your site",
  // The embed panel and the card (docs/design/sharing.md, Embed).
  embedTitle: "Embed on your site",
  embedDescription:
    "Put this poll on a news page or a community site. The card never takes an answer: every answer opens Abolish in a new tab.",
  embedKind: "What to embed",
  embedKindCard: "The poll card",
  embedKindCardNote:
    "Shows the question and its answers. Loads from {host} with no script and no cookies.",
  embedKindLink: "A plain link",
  embedKindLinkNote: "Just the poll as a link. Nothing loads from {host} until someone clicks.",
  embedTheme: "Colours",
  embedThemeAuto: "Match the reader's setting",
  embedThemeLight: "Light",
  embedThemeDark: "Dark",
  embedCode: "Code to paste into your page",
  embedCopy: "Copy code",
  embedCopied: "Code copied",
  embedCopyFailed: "Couldn't copy. Select the code above and copy it.",
  embedCardNote:
    "The card loads from {host} each time your page is read, so readers' browsers contact {host}, without cookies or a referrer.",
  embedLinkNote: "The link carries nothing about you, your site or your readers.",
  embedLinkLine: "Answer on Abolish; anyone can check the count.",
  embedPreview: "Open the card in a new tab",
  embedBack: "Back to sharing",
  embedNewTab: "(opens in a new tab)",
  embedPick: {
    one: "Pick one. Your pick opens Abolish in a new tab, where you check it and send it.",
    other:
      "Pick an answer to question 1 of {count}. It opens Abolish in a new tab, where you answer the rest and send them.",
  },
  embedAnswer: { one: "Answer on Abolish", other: "Answer {count} questions on Abolish" },
  embedSeePoll: "See the poll on {host}",
  embedCloses: "Closes",
  embedClosed: "Closed",
  embedOpens: "Opens",
  embedNeverHere: "Answers are taken only on Abolish, never in this card.",
  embedHiddenTitle: "This poll is hidden",
  embedHidden: "Moderation has hidden this poll's text, so it isn't shown here.",
  embedHiddenLink: "See why on its page",
  embedNotFoundTitle: "No poll here",
  embedNotFound: "This card's link doesn't name a poll.",
  // A poll's link preview: the image a chat draws and the text beside it (src/og/).
  ogHeadlineCode: "Poll {code}",
  ogHeadlineHost: "A poll on {host}",
  ogAskedBy: "Asked by {name}",
  ogAskedOn: "Asked on {host}",
  ogCloses: "Closes {day}",
  ogClosed: "Closed {day}",
  ogAnswersSoFar: { one: "{count} answer so far", other: "{count} answers so far" },
  ogAnswersCounted: { one: "{count} answer counted", other: "{count} answers counted" },
  ogSealed: "Results when it closes",
  ogSealedOn: "Results when it closes on {day}",
  ogSealedNote: "What people answer stays sealed until then.",
  ogSealedNoteCount: "{answers}. What they say stays sealed until then.",
  ogOpen: "Open",
  ogOpenUntil: "Open until {day}",
  ogCheck: "Anyone can check the count.",
  ogCheckCount: "{answers}. Anyone can check the count.",
  ogCountingHead: "Closed",
  ogCountingHeadOn: "Closed on {day}",
  ogCountingNote: "The count isn't published yet.",
  ogFinalCount: "Final count · {answers}",
  ogUpdated: "{answers} · updated {day}",
  ogQuestionOne: "Question 1 of {count}",
  ogQuestions: { one: "{count} question", other: "{count} questions" },
  ogCivic: "Civic record · {kind}",
  ogTiers: "Each tier is counted on its own.",
  ogTiersReleased: "Released {day}. Each tier is counted on its own.",
  ogTiersWill: "Each tier will be counted on its own.",
  ogRecount: "Anyone can recount it",
  ogWho: "Asked by {name}.",
  ogWhoIn: "Asked by {name} in {place}.",
  ogSoFar: "{answers}.",
  ogSealedText: "Results are sealed until it closes.",
  ogSealedTextOn: "Results are sealed until it closes on {day}.",
  ogOpenText: "Open until it closes.",
  ogOpenTextOn: "Open until it closes on {day}.",
  ogCountingText: "Closed; the count isn't published yet.",
  ogCountingTextOn: "Closed on {day}; the count isn't published yet.",
  ogClosedText: "Closed.",
  ogClosedTextOn: "Closed on {day}.",
  // The flyer (docs/design/sharing.md, Printable flyer).
  flyerTitle: "Print a flyer",
  flyerBack: "Back to the poll",
  flyerIntro:
    "For noticeboards, shop windows and meetings. The QR code and the link are the same for everyone, so a flyer says nothing about who put it up.",
  flyerPaper: "Paper",
  flyerPaperLetter: "US Letter",
  flyerPaperA4: "A4",
  flyerInk: "Ink",
  flyerInkColor: "Color",
  flyerInkMono: "Black and white",
  flyerPrint: "Print this flyer",
  flyerPrintNote:
    "Print at actual size. Only the flyer prints, edge to edge, so turn off headers and footers if your browser adds them.",
  flyerPreview: "The flyer, as it prints",
  flyerKicker: "A poll on {host}",
  flyerQuestions: {
    one: "{count} short question.",
    other: "{count} short questions, answered together.",
  },
  flyerScan: "Scan to answer",
  flyerScanClosed: "Scan to see the poll",
  flyerOrType: "or type",
  flyerCloses: "Closes {time}",
  flyerClosed: "Closed {time}",
  flyerOpens: "Opens {opens}, closes {closes}",
  flyerHowTitle: "How to answer",
  flyerHow:
    "Open the link on a phone or computer and tap your answer. It takes about a minute, and you can change it until the poll closes.",
  flyerClosedTitle: "This poll has closed",
  flyerClosedBody: "It no longer takes answers. Open the link to see where the count stands.",
  flyerCheckTitle: "Anyone can check the count",
  flyerCheck:
    "Every answer is sealed and listed on a public board, without the name of who sent it, and anyone can recount the result. During launch, Abolish alone holds the key for this poll.",
  flyerFoot: "Non-binding, run by citizens.",
  flyerTabs: "Tear-off tabs with the link",
  flyerHidden:
    "Moderation has hidden this poll's text, so there's no flyer for it. Its page says why.",
  // Why a poll couldn't be set up, one per failure code core writes
  // (@abolishus/core, POLL_FAILURES; ADR 0032, rule 14). A poll that can be
  // retried comes back as a draft; one whose election was registered stays.
  pollFailure_closesTooSoon:
    "Setting up took longer than expected, and your poll would have closed too soon after opening. Choose a later closing time and submit it again.",
  pollFailure_creationReverted:
    "Your poll couldn't be created on the public record. Your question wasn't published. You can try again or discard it.",
  pollFailure_creationReplaced:
    "Something went wrong on our side while your poll was being created, so we stopped. Your question wasn't published. You can try again or discard it.",
  pollFailure_creationTimeout:
    "Creating your poll on the public record took too long. Your question wasn't published. You can try again or discard it.",
  pollFailure_creationAnchored:
    "Your poll couldn't get a clean start on the public record after three tries, so its answers couldn't be protected. Your question wasn't published. You can try again or discard it.",
  pollFailure_tierUnavailable:
    "Polls can't be set up yet for the voters you chose. Your question wasn't published. Change who can answer and submit it again.",
  pollFailure_electorateEmpty:
    "Nobody could have answered: no one was yet in the group of voters you chose when your poll was set up. Your question wasn't published. You can try again later or discard it.",
  pollFailure_stubRefused:
    "Something went wrong on our side while your poll was being prepared. Your question wasn't published. You can try again or discard it.",
  pollFailure_registrationRefused:
    "The trustees' work on your poll didn't pass our checks, so we didn't register it. Your question wasn't published. You can try again or discard it.",
  pollFailure_registrationReverted:
    "The public record refused to register your poll. Your question wasn't published. You can try again or discard it.",
  pollFailure_registrationReplaced:
    "Something went wrong on our side while your poll was being registered, so we stopped. Your question wasn't published. You can try again or discard it.",
  pollFailure_registrationTimeout:
    "Registering your poll took too long. Your question wasn't published. You can try again or discard it.",
  pollFailure_registrationMismatch:
    "Something other than your poll was registered under its place on the public record, so we stopped before it opened. It will never take answers, and it stays on the record. To ask your question, start a new poll.",
  pollFailure_openMismatch:
    "What the public record holds for your poll isn't exactly what you wrote, so we didn't open it. It will never take answers, and it stays on the record. To ask your question, start a new poll.",
  pollFailure_ceremonyTimeout:
    "The poll's trustees couldn't finish preparing its keys after four tries. Your question wasn't published. You can try again or discard it.",
  pollFailure_openTimeout:
    "Your poll was registered but couldn't open before its closing time. It will never take answers, and it stays on the record. To ask your question, start a new poll.",
  evidenceSummary: "How do we know this is real?",
  evidenceFingerprintTitle: "This poll's fingerprint",
  evidenceFingerprint:
    "Drawn from the hash of the poll's definition, which fixes its rules before the first answer. A definition changed in any way draws a different shape.",
  fingerprintDefinition: "Fingerprint of definition {prefix}",
  evidenceDefinitionTitle: "What the poll commits to",
  pollId: "Poll ID",
  pollClaim:
    "Everything below is what our server says about this poll. The verifier checks it against the chain; this page doesn't.",
  definitionHash: "Definition hash, to compare with the election registry on chain",
  factType: "Counting",
  typePlurality: "One choice",
  typeApproval: "Approve any number",
  typeQuestions: "Question by question",
  questionCount: { one: "{count} question", other: "{count} questions" },
  factQuestions: "Questions",
  questionNumber: "Question {number}",
  questionLimits: "{instruction}, from {options}; {min} to {max} selections",
  instruction_one: "Pick one",
  instruction_any: "Pick any",
  instruction_upTo: "Pick up to {max}",
  instruction_exactly: "Pick exactly {count}",
  instruction_atLeast: "Pick at least {min}",
  instruction_between: "Pick {min} to {max}",
  factOptions: "Options",
  factSelections: "Selections per ballot",
  selectionsRange: "{min} to {max}",
  optionCount: { one: "{count} option", other: "{count} options" },
  factTrustees: "Trustees needed to decrypt the tally",
  trusteesOf: "{threshold} of {size}",
  factOpens: "Opens",
  factCloses: "Closes",
  factShortLink: "Short link",
  factElectorate: "Who can vote",
  tier0: "Tier 0 (passkey)",
  tier0_email: "Tier 0 (verified e-mail)",
  tier0_phone: "Tier 0 (verified e-mail and phone)",
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
  boardLink: "Read the board, entry by entry",
  boardPageEyebrow: "Poll {prefix}… · Public board",
  boardPageTitle: "The poll's board",
  boardPageLede:
    "Every record on this poll's board, in the order the board took them: the key ceremony, chain events, sealed ballots, openings and the count. Entries are only ever added at the end, and none shows how anyone voted.",
  boardPageBack: "Back to the poll",
  boardPageScope: "on this board as this page loaded",
  boardPageClaim:
    "These entries come from our server. This page decodes each one, checks that it names this poll and sits at its place, and computes its hash itself. Whether every entry chains to the head above is for the verifier, which checks the whole board.",
  boardLedgerMark: "The ledger",
  boardLedgerTitle: "Read the board, entry by entry",
  boardLedgerLede:
    "Each row is one entry: its number, the anchoring period the board added it in, what it records and its hash. The fingerprint draws the hash, so two copies can be compared without reading hex.",
  boardColumnEntry: "Entry",
  boardColumnPeriod: "Period",
  boardColumnKind: "Kind",
  boardColumnHash: "Entry hash",
  boardCaption: "Entries {first} to {last} of {count}",
  boardEnd: "This is the end of the board. Later entries will appear here.",
  boardBeyond: "The board has {count} entries, numbered from 0, so there is no entry {entry} yet.",
  boardPages: "Pages of the board",
  boardEarlier: "Earlier entries",
  boardLater: "Later entries",
  boardLatest: "Latest entries",
  boardOwnEntry:
    "This page doesn't look up a receipt's entry: asking our server for your own entry would tell it which one is yours, and each page here covers 25 entries so that browsing tells it less. To check your receipt, download the whole board and look for your entry there, where no one learns which one you looked for.",
  boardEntriesUndecodable:
    "Our server sent entries for this poll's board that don't check: one doesn't decode under the poll's definition, names another poll or sits at another place. This page shows none of them rather than show a board it can't read. Its board is unaffected wherever else it is copied.",
  fingerprintHead: "Fingerprint of the chain head {prefix}",
  fingerprintEntry: "Fingerprint of entry {entry}",
  entryKind_ballot: "Sealed ballot",
  entryKind_spoiledOpening: "Spoiled ballot, opened",
  entryKind_ceremony: "Key ceremony",
  entryKind_tallyOpening: "Count, opened",
  entryKind_contractEvent: "Chain event",
  entryKind_shareReceipt: "Trustee receipt",
  entryKind_shareComplaint: "Trustee complaint",
  entryKind_destruction: "Key destroyed",
  entryKind_closeStatement: "Close statement",
  entryKind_runningOpening: "Running count, opened",
  entryKind_authorApprovals: "Author's trustees' approval",
  illFormed:
    "This definition breaks a protocol rule ({rule}), so the verifier fails this election.",
  illFormedQuestion:
    "This definition breaks a protocol rule ({rule}) in question {number}, so the verifier fails this election.",
  "rule_protocol-major": "unsupported protocol version",
  "rule_profile-order": "record versions out of order",
  "rule_profile-types": "wrong record types",
  "rule_profile-version": "a record at version 0",
  "rule_option-count": "number of options",
  rule_selections: "selection limits",
  rule_questions: "no questions",
  rule_electorate: "who can vote",
  rule_cells: "result groups",
  rule_panel: "trustee panel",
  rule_chain: "chains and contracts",
  rule_timing: "opening and closing times",
  "rule_receipt-keys": "receipt keys",
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
  navDiscoverNote: "Search the questions people are asking",
  navPollsNote: "Every poll listed on this site",
  navModerationNote: "Why a poll was hidden or left out of search",
  navHomeNote: "Start again from the front page",
  footerClaim: "Non-binding, run by citizens, and every count can be checked.",
  footerRecord: "Every poll here is on a public board that anyone can download and count again.",
  footerNav: "The record",
  footerLanguage: "Language",
  otherPlaces: "Other places to go",
  notFoundCode: "404 · Not found",
  notFoundPageTitle: "Page not found",
  notFoundTitle: "There is no page at this address",
  notFound:
    "The link may be mistyped or cut short. Polls and their results are never deleted, so a poll's own link keeps working.",
  notFoundPoll:
    "Looking for a poll someone shared? Ask them to send the link again, or search for it below.",
  unavailableTitle: "Poll unavailable",
  definitionUndecodable:
    "The server sent a definition that doesn't decode under the protocol, so this page won't show it.",
  definitionMismatch:
    "The server sent the definition of another poll for this ID, so this page won't show it.",
  errorTitle: "Something went wrong on our side",
  errorPageTitle: "Something went wrong",
  error: "This page couldn't be shown. Try again in a moment, or go somewhere else below.",
  errorBallot:
    "This website never handles ballots: if you were voting, your ballot and receipt are safe in the ballot app on your device.",
  errorRetry: "Try again",
  offlineTitle: "You're offline",
  offline:
    "This device can't reach Abolish right now, so the page you opened couldn't load. It will open as usual once you're connected again.",
  offlineKept:
    "For times like this, your device keeps only this page and its fonts. No poll or account page you've opened is stored on it.",
  offlineRetry: "Try again",
  moderationEyebrow: "Moderation · Public and append-only",
  moderationTitle: "Moderation acts on poll text, never on results",
  moderationLede:
    "Every decision we make about a poll or a creator's profile is a row in this log, in the order we made it. Rows are only ever added: a decision is reversed by a later one, which stays beside it. The log doesn't name the moderator, the person who reported, or anyone's account: a profile appears only as its public handle.",
  moderationReach: "What moderation can reach",
  moderationActsOn: "Acts on",
  moderationActsOn_text: "A poll's question, options and description",
  moderationActsOn_listing: "Whether our pages list the poll, and under which topic and place",
  moderationActsOn_profile: "A creator's profile: its name and the polls it shows",
  moderationNeverActsOn: "Never acts on",
  moderationNeverActsOn_board: "Ballots and the board",
  moderationNeverActsOn_definition: "A poll's definition, electorate or closing time",
  moderationNeverActsOn_result: "The count and the result",
  moderationResultsStay:
    "Whatever our pages show, every poll's board stays public, and anyone who downloads it can count it again.",
  moderationLogMark: "The log",
  moderationLogTitle: "Decisions, oldest first",
  moderationLogLede:
    "Times are the database's clock, in UTC, not the moderator's. A row holds only the poll or profile, the action and its ground, never free text, so not even a profile's name or a poll's place: a refiling says only whether it changed or cleared the place. Our API serves the same log for anyone to copy:",
  moderationEmpty: "No decisions yet.",
  moderationSeq: "No.",
  moderationPoll: "Poll",
  moderationProfile: "Profile",
  moderationSubject: "Poll or profile",
  moderationAction: "Action",
  moderationReason: "Ground",
  moderationDecided: "Time",
  moderationMore: "Later decisions",
  moderationGroundsMark: "Grounds",
  moderationGroundsTitle: "The only seven grounds",
  moderationGroundsLede:
    "Every removal cites exactly one. We use the least restrictive action: a poll is delisted unless showing its text does harm itself.",
  ground_illegal:
    "Content that is illegal to host or distribute where we operate, such as child sexual abuse material.",
  "ground_personal-data":
    "Personal data of a private individual: a home address, phone number, identity number, health or financial details, or anything that identifies a voter.",
  ground_threat:
    "A credible threat of violence, or incitement to violence against a person or group.",
  ground_harassment: "Text that targets a private individual for abuse.",
  ground_spam: "Bulk or automated polls, scams, phishing or malware links.",
  ground_impersonation:
    "A poll presented as coming from a person, organization or authority that didn't create it.",
  "ground_legal-notice": "A notice or order we are legally bound to act on.",
  moderationNeverTitle: "Never grounds, whatever the pressure",
  moderationNever_viewpoint: "A poll's political or religious viewpoint",
  moderationNever_controversy: "Its subject being controversial",
  moderationNever_criticism: "Criticism of any person, government or organization, us included",
  moderationNever_publicFigure: "A public figure objecting to a poll about their public role",
  moderationNever_reports: "A poll being unpopular, or reported many times",
  moderationNever_result: "The poll's result or turnout, actual or expected",
  moderationRestoreTitle: "Grounds for restoring a poll",
  "ground_appeal-upheld": "The poll's creator appealed, and the appeal succeeded.",
  ground_error: "The removal was wrong on its face.",
  "ground_notice-withdrawn": "The legal notice behind it was withdrawn or overturned.",
  action_delist: "Delisted",
  action_hide: "Text hidden",
  action_restore: "Restored",
  profileAction_hide: "Profile hidden",
  action_refile: "Refiled",
  refiledTopic: "Topic now {topic}",
  refiledTopicCleared: "No topic",
  refiledPlaceChanged: "Place changed",
  refiledPlaceCleared: "No place",
  reason_misfiled: "Misfiled",
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
  accountEyebrow: "Account",
  accountTitle: "Sign in, or create an account",
  accountLede:
    "An account lets you create and manage polls. You don't need one to vote, and it never casts a vote: ballots are cast in the ballot app, and nothing here can tell how or whether you voted.",
  accountTitleAsk: "Sign in to ask your question",
  accountLedeAsk:
    "A question is asked from an account, which keeps it as a draft until you're ready and lets you come back to it. Sign in, or create an account with a passkey, and the question's form opens next.",
  accountEyebrowSignedIn: "Account · Signed in with a passkey",
  accountTitleSignedIn: "Your account",
  accountLedeSignedIn:
    "The passkeys that sign you in to this website. Your votes are not here: they live in the ballot app on your device.",
  accountNeedsScript: "Accounts use passkeys, which need this page's script.",
  accountHaveOne: "I have an account",
  accountHaveOneLede:
    "Your device will ask for your fingerprint, face or screen lock. There is no password.",
  accountNew: "I'm new here",
  accountNewLede:
    "We create a passkey on this device and keep only its public key. No name is needed. Then you verify an e-mail address, which voting needs: one account per address.",
  accountSignUp: "Create an account with a passkey",
  accountSignIn: "Sign in with a passkey",
  accountSignOut: "Sign out",
  accountSignOutOthers: "Sign out everywhere else",
  signedIn: "You're signed in.",
  signedOut: "You're signed out.",
  accountDeleted: "The account is deleted.",
  passkeyRemoved: "Passkey removed.",
  signedOutOthers: "Every other session of this account is signed out.",
  separationMark: "Accounts and votes",
  separationTitle: "Your account is not your vote",
  separationLede:
    "The two are kept apart by design. No table or log on our servers links an account to a ballot, and the ballot routes refuse any request that carries an account's cookie. Tests check both on every change.",
  separationServer: "On our servers",
  separationAccount: "Your account",
  separationAccount_passkeys: "Each passkey's public key, and when it was added",
  separationAccount_sessions: "Your sign-ins to this website",
  separationAccount_email: "Your e-mail address, encrypted",
  separationAccount_phone: "A keyed fingerprint of your phone number, never the number",
  separationAccountNote:
    "Who you are to this website. It can create and manage polls. It can't vote.",
  separationNeverJoined: "Never joined",
  separationDevice: "On your device",
  separationIdentity: "Your voting identity",
  separationIdentity_secret: "A secret that proves you may vote, without saying who you are",
  separationIdentity_receipts: "Your ballot receipts",
  separationIdentityNote:
    "It never leaves your device unencrypted. If you keep a backup, our server stores it sealed under the identity's own passkey, and can't open it.",
  passkeysTitle: "Passkeys",
  passkeysHeading: "How you sign in",
  passkeysLede:
    "Any of these signs you in to this account. Your voting identity has its own passkey, which isn't listed here: we never see it.",
  passkeySynced: "Synced passkey",
  passkeySyncedHelp: "Kept in step across your devices by your passkey provider",
  passkeyDevice: "Device passkey",
  passkeyDeviceHelp: "On one device or security key only",
  passkeyAddedAt: "Added {created} UTC",
  passkeyRemove: "Remove",
  passkeyRemoveWhich: "the passkey added {created} UTC",
  passkeyLast: "Your last passkey",
  passkeyAdd: "Add a passkey",
  passkeyAdded: "Passkey added.",
  noticesMark: "Notifications",
  noticesTitle: "What we tell you about",
  noticesLede:
    "By e-mail, to the address you verified above. Without one, nothing is sent, and what we'd tell you is still here on this page.",
  noticesModeration: "A moderation decision about one of your polls, your profile or your appeal",
  noticesModerationHelp:
    "Always sent, so that you can appeal. It can't be turned off. It comes in the language you verified your address in.",
  noticesWhen:
    "It comes the day after the decision and says only that there was one. What was decided, and why, is here on this page and in the public moderation log: we keep it out of the e-mail, so the service that delivers it learns as little as it can.",
  pushLabel: "Also notify this browser",
  pushHelp:
    "A notification on this device when the e-mail goes out, saying only that there was a decision. Your browser's maker delivers it, so it learns that you use Abolish and the day it was sent.",
  pushOn: "This browser will be notified.",
  pushOff: "This browser won't be notified.",
  pushUnsupported: "This browser can't show notifications from websites.",
  pushUnavailable: "This site doesn't send browser notifications yet.",
  pushDenied:
    "This browser blocks notifications from this site. Allow them in the browser's settings, then come back to this page.",
  pushFailure_signedOut: "You've been signed out. Sign in again to change notifications.",
  pushFailure_denied: "Notifications weren't allowed, so this browser won't be notified.",
  pushFailure_service:
    "This browser's notification service isn't one we can send through, so it can't be notified.",
  pushFailure_failed: "That didn't work. Try again.",
  pushNoticeTitle: "A moderation decision",
  pushNoticeBody:
    "About one of your polls, your profile or an appeal. Open your account page to see it.",
  exportMark: "Your data",
  exportTitle: "Download your data",
  exportLede: "A copy of your account's data, as one JSON file you can open in any text editor.",
  exportHolds_account:
    "When the account was made, its passkeys, sign-ins and sessions, and its moderator name if it moderates",
  exportHolds_verification:
    "Your verified e-mail address where this site can still read it, and the days your e-mail and phone were verified",
  exportHolds_polls: "Every poll you wrote, as you wrote it, what became of it, and your appeals",
  exportHolds_profile:
    "Your public profile, the polls it shows, its appeals and the day you last named it",
  exportHolds_reactions: "Your reactions to polls",
  exportHolds_token:
    "The group, region and key period of your Tier 0 token, never the voting identity it went to",
  exportNever:
    "It never holds your answers, receipts or voting identity: those stay on your device, and our servers can't tie them to your account. It holds no sign-in secrets, and not your phone number: we keep only a keyed fingerprint of it, which isn't in the file.",
  exportCare:
    "Keep the file somewhere safe: it dates when you used the site, and anyone who has it can read it.",
  exportDownload: "Download your data",
  exportPreparing: "Preparing your file…",
  exportDone: "Your data is downloading.",
  exportFailure_signedOut: "You've been signed out. Sign in again to download your data.",
  exportFailure_failed: "Your data couldn't be downloaded. Try again.",
  accountDeleteMark: "Delete",
  accountDeleteTitle: "Delete your account",
  accountDeleteLede:
    "This removes the account, its passkeys, its sign-ins and its profile from our servers.",
  accountDeleteStays:
    "Polls already published stay on the public board, and moderation decisions about them stay in the public log. Your voting identity and receipts are on your device and aren't affected.",
  accountDelete: "Delete account…",
  accountDeleteQuestion: "Delete this account? This can't be undone.",
  accountDeleteConfirm: "Delete account permanently",
  accountDeleteCancel: "Keep account",
  accountFailure_cancelled: "The passkey prompt was dismissed. Nothing changed.",
  accountFailure_unsupported: "This browser doesn't support passkeys.",
  profileMark: "Profile",
  profileTitle: "Your public profile",
  profileLede:
    "Optional. A profile puts a name of your choosing beside the polls you choose, as “Asked by”. It shows that name and those polls, nothing else: not your account, your e-mail or phone, and nothing about answering polls.",
  profileNone:
    "You don't have a profile, so your polls don't say who asked them. You can make one at any time, and delete it at any time.",
  profileNeedsPhoneHere:
    "A profile needs a verified phone number, and this site doesn't verify phone numbers yet.",
  profileNameLabel: "The name your profile shows",
  profileNameHelp:
    "A person, a group or a pseudonym, up to 60 characters. Names aren't checked and needn't be unique, and the name can change once a day. Moderators can hide a profile under the same rules as a poll.",
  profileMake: "Make profile",
  profileName: "Name",
  profileAddress: "Address",
  profileAddressHelp:
    "Chosen at random, and never given to anyone else. Anyone with the address sees the name and the polls the profile shows.",
  profilePolls: "Polls it shows",
  profilePollsNone: "None yet. You choose under each of your polls, above, which it shows.",
  profilePollsSome: "{count}. You choose under each of your polls, above, which it shows.",
  profileRename: "Change name",
  profileRenameSave: "Save name",
  profileRenameCancel: "Keep the name",
  profileRenameOn: "The name was set today. It can change again on {day} (UTC).",
  profileRenameHidden: "The name can't change while the profile is hidden.",
  profileDelete: "Delete profile…",
  profileDeleteQuestion: "Delete your profile?",
  profileDeleteMeans:
    "Its name and your choice of polls are deleted, and its address is retired for good. Your polls stay, without “Asked by”. Copies others made while it was shown, such as saved pages, may remain.",
  profileDeleteConfirm: "Delete profile",
  profileDeleteCancel: "Keep profile",
  profileMade: "Your profile is made. It shows no polls until you choose them.",
  profileRenamed: "The name is changed on your profile and every poll it shows.",
  profileSameName: "That's the name it has already. Nothing changed.",
  profileDeleted: "Your profile is deleted.",
  profileAppealed: "Your appeal is filed. A different moderator will review it.",
  profileMeans_visible: "Our pages show this profile again.",
  profileMeans_hidden:
    "Our pages show only this decision in place of the profile's name and polls, and your polls don't say who asked them. The polls themselves aren't affected.",
  profileAppeal_upheld: "upheld on {when} UTC, and the profile restored",
  profileAppeal_rejected: "rejected on {when} UTC",
  profileAppeal_superseded:
    "closed on {when} UTC, because a later decision changed the profile first",
  profileVerifyPhone: "Verify your phone",
  profileFailure_signedOut: "You've been signed out. Sign in again to see your profile.",
  profileFailure_phoneUnverified: "A profile needs your phone number verified first.",
  profileFailure_invalidName:
    "A profile can't have that name. Use 1 to 60 letters, digits, spaces or punctuation, with no invisible characters.",
  profileFailure_oneNameADay: "The name was set already today. Nothing changed.",
  profileFailure_hidden: "The profile is hidden, so its name can't change. Nothing changed.",
  profileFailure_changed:
    "Your profile changed since this page read it. This shows how it stands now.",
  profileFailure_failed: "That didn't work. Nothing changed; try again shortly.",
  profileFailure_unloaded: "Your profile couldn't be loaded. Try again shortly.",
  profileFailure_moderationUnloaded:
    "This profile's moderation couldn't be loaded. Try again shortly.",
  profileChoiceLabel: "Show on your profile,",
  profileChoiceHelp:
    "Your profile lists this poll, and its page says your profile asked it, while the poll is listed. Untick it at any time.",
  profileChoiceHelpUnsaved:
    "Saving the draft puts it on your profile. Your profile lists it, and its page says your profile asked it, once the poll is open and listed.",
  profileChoiceShown: "Your profile shows this poll.",
  profileChoiceUnshown: "Your profile doesn't show this poll.",
  profileChoiceNone:
    "Your polls don't say who asked them. To put a name beside them, make a public profile.",
  profileChoiceNoneLink: "Make one on your account page",
  profileChoiceFailure_signedOut: "You've been signed out. Sign in again to choose.",
  profileChoiceFailure_changed:
    "Your profile or this poll changed since the page read it. Nothing changed here.",
  profileChoiceFailure_failed: "That didn't work. Nothing changed; try again shortly.",
  profileChoiceFailure_unsaved:
    "The draft is saved, but your profile doesn't show it. Tick the box again to show it.",
  byEyebrow: "Profile",
  byLede:
    "The polls this profile shows, the latest first. Its author chose the name: names aren't checked and needn't be unique.",
  byNote:
    "Which polls a profile shows is what its author told this website. It isn't part of any poll, and no one outside this website can check it.",
  byPolls: "Polls it asked",
  askedBy: "Asked by",
  askedByNote:
    "Who asked is what the poll's author told this website. It isn't part of the poll, and no one outside this website can check it.",
  byEmpty: "No polls to show",
  byEmptyLede: "This profile doesn't show any poll that's listed right now.",
  byMore: "More polls",
  byHiddenTitle: "This profile is hidden",
  byHidden:
    "Moderators hid it under the moderation policy, for {reason}. Its name and polls aren't shown here, and its polls don't say who asked them. The polls themselves are moderated separately.",
  byHiddenLog: "See the decision in the public moderation log",
  byReportTitle: "Something wrong with this profile?",
  byReportHelp:
    "Reports are counted, never who sent them, and a moderator judges the profile against the policy: the number of reports never decides anything.",
  byReportPolicy: "What moderation can and can't do",
  byReport: "Report this profile",
  byReportLegend: "Why should a moderator look at it?",
  byReportSend: "Send report",
  byReportCancel: "Cancel",
  byReportDone: "Reported. A moderator will look at it.",
  byReportGone: "This profile no longer exists, so nothing was reported.",
  byReportFailed: "That didn't work. Nothing was reported; try again shortly.",
  pollsMark: "Your polls",
  pollsTitle: "Polls you created",
  pollsLede:
    "Your drafts, polls being set up and polls that have opened. Only you see this list: the public record never names who created a poll.",
  pollsEmpty: "You haven't created a poll yet.",
  pollsUntitled: "Untitled draft",
  pollsState_drafted: "Draft",
  pollsState_setup: "Setting up",
  pollsState_open: "Open",
  pollsState_failed: "Didn't open",
  pollsEdited: "Last edited {when} UTC",
  pollsSubmitted: "Submitted {when} UTC",
  pollsCloses: "Closes {when} UTC",
  pollsSetupHelp:
    "Setting up takes a while, mostly waiting for the public record to settle. You can leave this page, or follow its setup step by step.",
  pollsFollowSetup: "Follow its setup",
  pollsPage: "Go to its page",
  pollsDelete: "Delete draft…",
  pollsDeleteQuestion: "Delete this draft? This can't be undone.",
  pollsDeleteConfirm: "Delete draft permanently",
  pollsRetry: "Try again",
  pollsDiscard: "Discard…",
  pollsDiscardQuestion: "Discard this poll and its draft? This can't be undone.",
  pollsDiscardConfirm: "Discard permanently",
  pollsKeep: "Keep it",
  pollsRemoved: "The draft is deleted.",
  pollsRetried: "Your poll is a draft again, as you wrote it.",
  pollsDiscarded: "The poll is discarded.",
  pollsFailure_signedOut: "You've been signed out. Sign in again to see your polls.",
  pollsFailure_gone: "That poll is no longer here. The list is up to date now.",
  pollsFailure_changed: "That poll changed since the list was shown. The list is up to date now.",
  pollsFailure_registered: "That poll is registered on the public record, so it stays.",
  pollsFailure_tooManyDrafts:
    "You have as many drafts as an account can hold. Delete one, then try again.",
  pollsFailure_failed: "That didn't work. Nothing changed; try again shortly.",
  pollsFailure_unlisted: "Your polls couldn't be loaded. Try again shortly.",
  pollsFailure_refused:
    "The server found a problem with that draft, so it wasn't saved. Check it and try again.",
  moderationOfPoll: "Moderation",
  moderationDecision: "{action}: {reason}, {when} UTC",
  moderationMeans_visible: "Our pages list and show this poll again.",
  moderationMeans_delisted:
    "Our pages don't list this poll, but it stays open at its address. The board, the count and the result aren't affected.",
  moderationMeans_hidden:
    "Our pages don't show this poll's text. The board, the count and the result aren't affected.",
  moderationAppealed: "You appealed decision No. {seq} on {when} UTC: {outcome}.",
  moderationAppealPending: "waiting for a moderator other than the one who decided",
  moderationAppeal_upheld: "upheld on {when} UTC, and the poll restored",
  moderationAppeal_rejected: "rejected on {when} UTC",
  moderationAppeal_superseded:
    "closed on {when} UTC, because a later decision changed the poll first",
  moderationAppeal: "Appeal this decision…",
  moderationAppealQuestion:
    "Appeal this decision? A moderator other than the one who decided reviews it. You can appeal a decision only once.",
  moderationAppealConfirm: "Send appeal",
  moderationAppealCancel: "Not now",
  moderationAppealFiled: "Your appeal is filed. A different moderator will review it.",
  moderationFailure_signedOut:
    "You've been signed out. Sign in again to see this poll's moderation.",
  moderationFailure_gone: "That poll is no longer here.",
  moderationFailure_changed:
    "That decision changed or was already appealed since this page read it. This shows how it stands now.",
  moderationFailure_failed: "The appeal didn't go through. Nothing changed; try again shortly.",
  moderationFailure_unloaded: "This poll's moderation couldn't be loaded. Try again shortly.",
  pollsFailure_tooManyInSetup:
    "You have as many polls setting up as an account can at once. Submit this one when one of them has opened.",
  pollsFailure_tooManyToday:
    "You've submitted as many polls in the last 24 hours as an account can. Try again later.",
  pollsFailure_challengeRefused:
    "The check that you're a person didn't pass, so nothing was submitted. Submit again to take a new one.",
  pollsFailure_challengeUnavailable:
    "The check that you're a person couldn't run just now, so nothing was submitted. Try again shortly.",
  pollsCreate: "Ask a question",
  pollsEdit: "Edit draft",
  pollFormEyebrow: "Your polls",
  pollFormNewEyebrow: "New poll",
  pollFormNewTitle: "Ask a question",
  pollFormEditTitle: "Edit your poll",
  pollFormLede:
    "Only you can see a draft, and you can change it as often as you like until you submit it.",
  pollFormBack: "Back to your polls",
  pollFormNeedsScript: "Saving a draft needs this page's script.",
  pollFormLoading: "Loading your draft…",
  pollFormSignedOut:
    "You've been signed out. Sign in on your account page, then come back to this draft.",
  pollFormGone: "That draft is no longer here. It may have been deleted in another tab.",
  pollFormNotDraft:
    "This poll was submitted for setup, so it can't be changed any more. Your polls list shows how it's doing.",
  pollFormUnloaded: "Your draft couldn't be loaded. Try again shortly.",
  setupEyebrow: "Your polls",
  setupTitle: "Setting up your poll",
  setupLede:
    "Before anyone can answer, your poll goes on the public record, the people who can answer are counted, and its trustees make the key that seals every answer. This can take up to half an hour, mostly waiting for the public record to settle.",
  setupBack: "Back to your polls",
  setupNeedsScript:
    "Following setup needs this page's script. Your polls list on the account page shows how it's doing.",
  setupLoading: "Loading your poll…",
  setupSignedOut:
    "You've been signed out. Sign in on your account page to see how your poll is doing.",
  setupGone: "That poll is no longer here. It may have been discarded in another tab.",
  setupUnloaded: "Your poll couldn't be loaded. This page tries again in a few seconds.",
  setupStepsLabel: "Setting up, step by step",
  setupStep_submitted: "Submitted",
  setupStep_created: "Put on the public record",
  setupStep_rooted: "The people who can answer counted",
  setupStep_keyed: "The trustees make the key that seals answers",
  setupStep_opened: "Checked and opened for answers",
  setupWhere_done: "done",
  setupWhere_now: "under way",
  setupWhere_later: "still to come",
  setupNow: "Now: {step}.",
  setupLeave:
    "This page checks again every few seconds. You can leave it: setup carries on, and your polls list shows how it's doing.",
  setupStale: "This page couldn't check just now. It tries again in a few seconds.",
  setupOpen: "Your poll is open.",
  setupOpenUntil: "People can answer until {when} UTC.",
  setupPollPage: "Go to your poll's page",
  setupDraft: "This poll hasn't been submitted, so nothing is being set up.",
  setupFailed: "Your poll didn't open.",
  setupFailedNext: "Back to your polls, to try again or discard it",
  pollFormAboutMark: "The poll",
  pollFormAboutTitle: "What is it about?",
  pollFormTitleLabel: "Title",
  pollFormTitleHelp: "What people see first, in lists and on the poll's page.",
  pollFormDescriptionLabel: "Description",
  pollFormOptional: "(optional)",
  pollFormDescriptionHelp: "Background people need to answer fairly.",
  pollFormPlaceLabel: "Place",
  pollFormPlaceHelp:
    "A town, a neighbourhood, a school. Anyone can see it, so name somewhere public rather than your own address.",
  pollFormTopicLabel: "Topic",
  pollFormTopicHelp: "Helps people find your poll.",
  pollFormTopicNone: "No topic",
  pollFormTagsNote:
    "The place and topic only decide where your poll is listed. They aren't part of the poll itself, and moderation can change them if they don't fit.",
  pollFormQuestionsMark: "Questions",
  pollFormQuestionsTitle: "What are you asking?",
  pollFormQuestionsLede:
    "Each question has its options and a rule for how many an answer picks. Every answer to your poll answers all of its questions.",
  pollFormQuestion: "Question {n}",
  pollFormQuestionLabel: "What do you want to ask?",
  pollFormQuestionDescriptionLabel: "Explanation",
  pollFormQuestionDescriptionHelp: "A line or two under the question.",
  pollFormRuleLegend: "How many options does an answer pick?",
  pollFormRule_one: "One",
  pollFormRule_any: "Any number",
  pollFormRule_upTo: "Up to a number",
  pollFormRule_exactly: "Exactly a number",
  pollFormRule_between: "Between two numbers",
  pollFormMinLabel: "At least",
  pollFormMaxLabel_upTo: "Up to",
  pollFormMaxLabel_exactly: "Exactly",
  pollFormMaxLabel_between: "At most",
  pollFormOptionalLabel: "People can leave this question blank",
  pollFormOptionsLegend: "Options",
  pollFormOption: "Option {n}",
  pollFormOptionDescriptionLabel: "Details for option {n}",
  pollFormAddOption: "Add an option",
  pollFormAddOptionTo: "to question {n}",
  pollFormAddQuestion: "Add a question",
  pollFormMoveUp: "Move {what} up",
  pollFormMoveDown: "Move {what} down",
  pollFormRemove: "Remove {what}",
  pollFormWhatQuestion: "question {n}",
  pollFormWhatOption: "option {n} of question {q}",
  pollFormWhoMark: "Who can answer",
  pollFormWhoTitle: "Who can answer?",
  pollFormWhoLede:
    "Today's polls run at Tier 0: anyone with a voting identity on their device can answer, and anyone can make several. Its result counts identities, not people, and says so. Stricter tiers are being built.",
  pollFormWhenMark: "When it closes",
  pollFormWhenTitle: "When does it close?",
  pollFormWhenLede:
    "Times are in UTC, the clock every poll keeps. Your poll opens about half an hour after you submit it, once it is set up, and must then stay open for at least an hour, so choose a time at least 90 minutes from now and no more than a year ahead.",
  pollFormDateLabel: "Closing date (UTC)",
  pollFormTimeLabel: "Closing time (UTC)",
  pollFormLocal: "That's {when} where you are.",
  pollFormPreviewMark: "Preview",
  pollFormPreviewTitle: "What people will see",
  pollFormPreviewEmpty: "Your poll's title",
  pollFormPreviewQuestionEmpty: "Your question",
  pollFormPreviewOptionEmpty: "An option",
  pollFormPreviewCloses: "Closes {when} UTC",
  pollFormPreviewRule_one: "Choose one.",
  pollFormPreviewRule_any: "Choose any number.",
  pollFormPreviewRule_upTo: "Choose up to {count}.",
  pollFormPreviewRule_exactly: "Choose exactly {count}.",
  pollFormPreviewRule_between: "Choose {min} to {max}.",
  pollFormPreviewOptional: "You can leave this question blank.",
  pollFormPreviewListed: "Where it's listed",
  pollFormPreviewNotListed: "Not under any topic or place.",
  pollFormReviewTitle: "Check it through",
  pollFormReviewLede:
    "This is what you're submitting. Change anything on this page, then save before you submit.",
  pollFormReviewPermanent: "Recorded for good",
  pollFormReviewPermanentLede:
    "These go on the public record when you submit. Nobody can change them afterwards, you or us.",
  pollFormReviewListing: "Where it's listed",
  pollFormReviewListingLede:
    "These aren't part of the poll. They decide where people find it, and moderation can change them.",
  pollFormReviewTitleRow: "Title",
  pollFormReviewQuestions: "Questions",
  pollFormReviewQuestionCount: { one: "{count} question", other: "{count} questions" },
  pollFormReviewWho: "Who can answer",
  pollFormReviewCloses: "Closes",
  pollFormReviewPlace: "Place",
  pollFormReviewTopic: "Topic",
  pollFormReviewNone: "None",
  pollFormReviewNotSet: "Not set",
  pollFormReviewClosesAt: "{when} UTC",
  pollFormReviewUntitled: "No title yet",
  pollFormReviewChange: "Change",
  pollFormSave: "Save draft",
  pollFormSaved: "Your draft is saved.",
  pollFormSubmitMark: "Submit",
  pollFormSubmitTitle: "Ready to ask?",
  pollFormSubmitLede:
    "Submitting sets your poll up on the public record, and it opens for answers when that's done. You can't change it after you submit.",
  pollFormSubmitCloudflare:
    "Before it's sent, a check by Cloudflare confirms you're a person. Cloudflare sees your browser's address while it runs.",
  pollFormSubmit: "Submit poll",
  pollFormSubmitCheckLabel: "Check that you're a person",
  pollFormSubmitChecking: "Complete the check to submit your poll.",
  pollFormSubmitting: "Submitting your poll…",
  pollFormSubmitted: "Your poll is submitted. Taking you to its setup…",
  pollFormSubmitSaveFirst: "Save your draft first: only a saved draft can be submitted.",
  pollFormSubmitUnavailable: "Polls can't be submitted on this site just now.",
  pollFormSubmitRefused:
    "The server found a problem with this draft, so it wasn't submitted. Check when it closes, save it and try again.",
  pollFormErrorsTitle: "Your draft wasn't saved",
  pollFormSubmitErrorsTitle: "Your poll wasn't submitted",
  pollFormErrorsLede: "Fix these and save again:",
  pollFormInQuestion: "Question {n}: {problem}",
  pollForm_titleMissing: "Give your poll a title.",
  pollForm_tooLong: "This is too long.",
  pollForm_unstorable: "This holds a character that can't be saved. Retype it.",
  pollForm_placeTooLong: "A place can be up to 80 letters long.",
  pollForm_placeRefused:
    "This holds a hidden character or a text-direction mark a place can't have. Retype it.",
  pollForm_questionMissing: "Write the question.",
  pollForm_questionRepeated:
    "Another question already asks this. Each question needs its own words.",
  pollForm_labelMissing: "Give this option its words, or remove it.",
  pollForm_labelRepeated:
    "Another option of this question says the same. People couldn't tell them apart.",
  pollForm_tooFewOptions: "A question needs at least two options.",
  pollForm_tooManyOptions: "A poll can have 64 options across all its questions.",
  pollForm_tooManyQuestions: "A poll can have 32 questions.",
  pollForm_rangeInvalid:
    "These numbers don't fit the options: an answer must be able to pick at least one, and no more than there are.",
  pollForm_closesMissing: "Choose a closing date and time.",
  pollForm_closesTooSoon: "Choose a time at least 90 minutes from now.",
  pollForm_closesTooLate: "Choose a time no more than a year from now.",
  pollForm_draftTooLong: "Your poll is too long altogether. Shorten its text or remove a question.",
  pollForm_draftRefused: "Your poll breaks a rule the form couldn't point at. Check it through.",
  pollTopic_community: "Community",
  pollTopic_culture: "Culture",
  pollTopic_economy: "Economy",
  pollTopic_education: "Education",
  pollTopic_environment: "Environment",
  pollTopic_food: "Food",
  pollTopic_government: "Government",
  pollTopic_health: "Health",
  pollTopic_housing: "Housing",
  pollTopic_safety: "Safety",
  pollTopic_science: "Science",
  pollTopic_sport: "Sport",
  pollTopic_technology: "Technology",
  pollTopic_transport: "Transport",
  verifyEyebrow: "Account · Verification",
  verifyPageTitle_email: "Verify your e-mail",
  verifyPageTitle_phone: "Verify your e-mail and phone",
  verifyPageLede_email:
    "Voting needs an account verified by an e-mail address, and an address verifies one account only. It never reaches a poll, a ballot or the public record.",
  verifyPageLede_phone:
    "Voting needs an account verified by an e-mail address and a phone number, and a phone number verifies one account only. That keeps one person from making many accounts as cheaply as many passkeys. We ask for the number when you first vote, or you can verify it now. Neither ever reaches a poll, a ballot or the public record.",
  verifyBack: "Back to your account",
  verifyNeedsScript: "Verifying needs this page's script.",
  verifyCloudflare:
    "Before a code is sent, a check by Cloudflare confirms you're a person. Cloudflare sees your browser's address while it runs.",
  verifyMark_email: "E-mail",
  verifyMark_phone: "Phone",
  verifyHeading_email: "Your e-mail address",
  verifyHeading_phone: "Your phone number",
  verifyLede_email:
    "We keep your address encrypted, to send you codes and, later, the notices you ask for. It's never shown to anyone else.",
  verifyLede_phone:
    "We never keep your number: only a keyed fingerprint of it, so it can't verify a second account. A mobile gets a text, a home phone a call. The provider that sends the code sees the number.",
  verifyLoading: "Loading…",
  verifyVerified_email: "Verified: {address}, on {date} UTC.",
  verifyVerified_phone: "Verified on {date}. We don't keep the number, so we can't show it.",
  verifyNone_email: "No address is verified yet.",
  verifyNone_phone: "No phone number is verified yet.",
  verifyChange_email: "Use another address",
  verifyChange_phone: "Use another number",
  verifyLabel_email: "E-mail address",
  verifyLabel_phone: "Phone number",
  verifyHelp_email: "We send an 8-digit code to it.",
  verifyHelp_phone:
    "A US or Canadian number, with or without +1. Internet and virtual numbers can't be used.",
  verifySend: "Send a code",
  verifyCheckLabel: "Check that you're a person",
  verifyChecking: "Complete the check to send your code.",
  verifySending: "Sending your code…",
  verifySent_email:
    "We sent a message to {address}. Enter the code from it; it works for 15 minutes. Nothing arrived? Check the address and send another.",
  verifySent_phone:
    "If {number} can take a code, one is on its way, by text to a mobile or by a call to a home phone. It works for 10 minutes. Nothing arrived? Check the number and send another.",
  verifyCodeLabel: "Code",
  verifyCodeSubmit: "Verify",
  verifyStartOver: "Start over",
  verifyCancel: "Cancel",
  verifyChecked_email: "Your e-mail address is verified.",
  verifyChecked_phone: "Your phone number is verified.",
  verifyNoTarget_email: "Enter your e-mail address.",
  verifyNoTarget_phone: "Enter your phone number.",
  verifyNoCode: "Enter the code you were sent.",
  verifyFailure_signedOut: "You've been signed out. Sign in on your account page, then come back.",
  verifyFailure_unavailable: "This site can't verify this yet.",
  verifyFailure_invalidAddress:
    "That isn't an e-mail address we can send to. Check it and try again.",
  verifyFailure_invalidNumber: "That isn't a phone number. Check it and try again.",
  verifyFailure_unsupportedCountry:
    "For now we can only verify numbers from the US and Canada. We're sorry: without one, you can't verify an account yet.",
  verifyFailure_virtualNumber:
    "This looks like an internet or virtual number. Please use a mobile or home phone.",
  verifyFailure_tooManyThisHour:
    "You've asked for as many codes as you can this hour. Try again in an hour.",
  verifyFailure_tooManyToday:
    "You've asked for as many codes as you can today. Try again tomorrow.",
  verifyFailure_serviceBusy: "We've sent as many phone codes today as we can. Try again tomorrow.",
  verifyFailure_challengeRefused:
    "The check that you're a person didn't go through. Send the code again to take a new one.",
  verifyFailure_challengeUnavailable:
    "The check that you're a person couldn't load. Try again shortly.",
  verifyFailure_lookupUnavailable: "We couldn't check that number just now. Try again shortly.",
  verifyFailure_noCode: "No code is waiting for this. Send a new one.",
  verifyFailure_expired: "That code has expired. Send a new one.",
  verifyFailure_wrongCode: "That code isn't right. Check it and try again.",
  verifyFailure_wrongCodeTries: "That code isn't right. Tries left for this code: {count}.",
  verifyFailure_tooManyTries: "That code had too many wrong tries. Send a new one.",
  verifyFailure_checkUnavailable:
    "We couldn't check the code just now. No try was spent: try again shortly.",
  verifyFailure_addressTaken:
    "This address can't verify this account: another account has verified it, or one let it go less than 90 days ago.",
  verifyFailure_numberHeld:
    "This number can't verify this account: another account holds it, or one let it go less than 90 days ago.",
  verifyFailure_failed: "That didn't work. Nothing changed; try again shortly.",
  verificationMark: "Verification",
  verificationTitle_email: "E-mail",
  verificationTitle_phone: "E-mail and phone",
  verificationLede_email: "Voting needs a verified e-mail address: one account per address.",
  verificationLede_phone:
    "Voting needs a verified e-mail address and phone number: one account per number. We ask for the number when you first vote.",
  verificationPhoneLater: "Asked for when you first vote",
  verificationEmail: "E-mail",
  verificationPhone: "Phone",
  verificationEmailDone: "Verified: {address}",
  verificationPhoneDone: "Verified on {date}",
  verificationNotYet: "Not verified yet",
  verificationUnavailable: "Not available on this site yet",
  verificationUnread: "Couldn't be loaded",
  verificationGo: "Verify your e-mail",
  verificationManage_email: "Change your e-mail",
  verificationManage_phone: "Manage your e-mail and phone",
  accountFailure_failedSignedOut: "That didn't work. Nothing changed; try again shortly.",
  accountFailure_failed:
    "That didn't work. Adding a passkey or deleting the account needs a sign-in from the last day: sign out, sign in again and retry.",
} as const;

export type Messages = Record<keyof typeof enUS, Message>;

/**
 * The words for each code a failed poll carries (`failure` on `/drafts`),
 * so the page never shows the code itself (ADR 0032, rule 14). A code core
 * adds without a message here fails type-checking.
 */
export const POLL_FAILURE_MESSAGES: Readonly<Record<PollFailure, keyof Messages>> = {
  "closes-too-soon": "pollFailure_closesTooSoon",
  "creation-reverted": "pollFailure_creationReverted",
  "creation-replaced": "pollFailure_creationReplaced",
  "creation-timeout": "pollFailure_creationTimeout",
  "creation-anchored": "pollFailure_creationAnchored",
  "tier-unavailable": "pollFailure_tierUnavailable",
  "electorate-empty": "pollFailure_electorateEmpty",
  "stub-refused": "pollFailure_stubRefused",
  "registration-refused": "pollFailure_registrationRefused",
  "registration-reverted": "pollFailure_registrationReverted",
  "registration-replaced": "pollFailure_registrationReplaced",
  "registration-timeout": "pollFailure_registrationTimeout",
  "registration-mismatch": "pollFailure_registrationMismatch",
  "open-mismatch": "pollFailure_openMismatch",
  "ceremony-timeout": "pollFailure_ceremonyTimeout",
  "open-timeout": "pollFailure_openTimeout",
};

/**
 * The words for each topic a poll can be filed under (ADR 0041, rule 1), so
 * the page never shows the code itself. A topic core adds without a message
 * here fails type-checking.
 */
export const POLL_TOPIC_MESSAGES: Readonly<Record<PollTopic, keyof Messages>> = {
  community: "pollTopic_community",
  culture: "pollTopic_culture",
  economy: "pollTopic_economy",
  education: "pollTopic_education",
  environment: "pollTopic_environment",
  food: "pollTopic_food",
  government: "pollTopic_government",
  health: "pollTopic_health",
  housing: "pollTopic_housing",
  safety: "pollTopic_safety",
  science: "pollTopic_science",
  sport: "pollTopic_sport",
  technology: "pollTopic_technology",
  transport: "pollTopic_transport",
};

/**
 * A tier's name on a poll's page and in its editor, or none for a tier that
 * has no name. Tier 0 is named by what this deployment checks before an
 * account takes a token (`PHONE_VERIFICATION`; [[0038-verified-accounts]],
 * Owner decision (2026-10-22)), so a poll never claims a phone check the
 * issuer doesn't make (T-01).
 */
export function tierMessage(tier: Tier, phoneVerification: boolean): keyof Messages;
export function tierMessage(tier: number, phoneVerification: boolean): keyof Messages | undefined;
export function tierMessage(tier: number, phoneVerification: boolean): keyof Messages | undefined {
  if (tier === 0) return phoneVerification ? "tier0_phone" : "tier0_email";
  return tier === 1 ? "tier1" : tier === 2 ? "tier2" : undefined;
}

// The source catalog is in every page's script; each other one is a chunk of
// its own, loaded only for a page in its language, so no visitor downloads a
// language they aren't reading (P2-28 part 4; T-55, the budgets in
// tests/ssr.test.ts). A locale without a loader here fails type-checking.
const LOADERS: Readonly<Record<Exclude<Locale, "en-US">, () => Promise<Messages>>> = {
  "es-US": async () => (await import("./messages.es-US.ts")).esUS,
};

const loaded: Partial<Record<Locale, Messages>> = { "en-US": enUS };

/**
 * The catalogs as `useTranslate` reads them, by the I18nProvider's locale:
 * the source's always, and another once `loadCatalog` has loaded it, which
 * the server does before rendering a page (src/start.ts) and the browser
 * before hydrating one (src/router.tsx).
 */
export const catalogs: Readonly<Record<string, Messages>> = loaded;

/** Loads `locale`'s catalog, once; every later call answers from memory. */
export async function loadCatalog(locale: Locale): Promise<Messages> {
  const have = loaded[locale];
  // Only the source's is there from the start, so `locale` here is another's.
  if (have !== undefined) return have;
  const catalog = await LOADERS[locale as Exclude<Locale, "en-US">]();
  loaded[locale] = catalog;
  return catalog;
}

/** `locale`'s catalog, which must already be loaded: a page's always is. */
export function catalogFor(locale: Locale): Messages {
  const catalog = loaded[locale];
  if (catalog === undefined) throw new Error(`the catalog for "${locale}" isn't loaded`);
  return catalog;
}

/**
 * Each locale's name in its own language, for the footer's switch: a reader
 * looks for the language they read, so it is never translated, and each is
 * marked with its own `lang` where it shows (WCAG 3.1.2).
 */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  "en-US": "English",
  "es-US": "Español",
};
