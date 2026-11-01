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
  homeFeaturedAll: "More of the most answered",
  homeStreamEmpty: "No questions are open just now. When someone asks one, it shows up here.",
  homeListUnavailable:
    "The newest questions couldn't be loaded just now. Try again in a little while.",
  trustTitle: "Why you can trust a casual poll",
  trustLede:
    "A question about street trees is sealed, posted and counted the same way as a referendum. Here is what happens to an answer, in four steps.",
  trustHowItWorks: "How it works, in full",
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
    "Anyone who can get several e-mail addresses, and phone numbers where we ask for one, can open several accounts. A Tier 0 result describes what accounts said, not what people think.",
  howWeakSybilLimit:
    "It is always reported on its own and labelled as such, never blended into a total.",
  howWeakDocumentsTitle: "One person can hold two documents",
  howWeakDocumentsMeans:
    "Tier 2 lets each document join once, not each person. Someone with two valid documents, such as passports from two countries, joins twice, and so does anyone holding another person's document, or a copy of its chip's data. A government that issues documents could issue extra ones.",
  howWeakDocumentsLimit:
    "Not mitigated: a Tier 2 result counts documents, and is reported on its own beside its tier. Tier 2 isn't open yet.",
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
  howVerify: "How to verify a result yourself",
  howSource:
    "The protocol, its threat model (with every entry named above) and the source code are published in the open at github.com/abolishus/abolish.",
  navVerify: "Verify it yourself",
  recountEyebrow: "Verify it yourself",
  recountTitle: "Count a poll again without us",
  recountLede:
    "The verifier is an open-source program anyone can run. It reads a poll's board, its anchors on Ethereum and its proofs, checks every one, and gives the same answer whoever runs it. It never asks our servers anything.",
  recountNotYetTitle: "Not yet for the polls on this site",
  recountNotYetBody:
    "Our servers don't anchor boards to Ethereum yet, so the verifier finds no poll of ours to check. Until the anchor runs, each poll's board page checks what it can of our server's word, and a test election on a local chain is checked by the verifier on every change to our code.",
  recountRunMark: "Run it",
  recountRunTitle: "Four commands, one verdict per poll",
  recountRunLede:
    "You need Git, Node.js and Vite+, the toolchain the code is built with. The verifier isn't published as a program to install yet, so it runs from a copy of the source.",
  recountStep1Title: "Get the source",
  recountStep1Body: "Copy the code and install what it depends on, at the exact versions it pins.",
  recountStep2Title: "Copy the boards",
  recountStep2Body:
    "The community node reads every checkpoint anchored on Ethereum and copies the board files it names from IPFS, checking each block against its address.",
  recountStep3Title: "Verify every poll",
  recountStep3Body:
    "For each poll the anchors name, the node gathers its inputs from both chains and the copied boards, runs the verifier and writes the inputs and the report side by side.",
  recountStep4Title: "Check one again on its own",
  recountStep4Body:
    "The verifier alone, on the inputs the node gathered, runs the same checks. It prints a report and a summary, and its exit code is the verdict.",
  recountValueL1: "An Ethereum node you trust to say which block is final. Your own is best.",
  recountValueL2:
    "A node of the network polls are registered on, trusted for the records it holds.",
  recountValueGateway: "Any IPFS gateway, or the node's own. Every block it sends is checked.",
  recountValueAnchor: "The board anchor's address, as a release of the code pins it.",
  recountValueRegistry: "The election registry's address, as a release of the code pins it.",
  recountValuePoll: "The poll's ID, in lower-case hex.",
  recountExitCaption: "What the exit code means",
  recountExitCode: "Code",
  recountExitVerdict: "Verdict",
  recountExit0: "Verified",
  recountExit0Means: "Every check passed.",
  recountExit20: "Failed",
  recountExit20Means: "A check failed. The report says which, and why.",
  recountExit21: "Unverifiable",
  recountExit21Means:
    "Something couldn't be checked, such as a missing copy or an input nothing proves. Never counted as a pass.",
  recountExit22: "Rejected",
  recountExit22Means: "The inputs were malformed, so there is no report.",
  recountExit64: "Usage",
  recountExit64Means: "The command wasn't one it takes, or it was asked for its help.",
  recountExitOther:
    "Any other code is a failure of the verifier itself and says nothing about the poll.",
  recountChecksMark: "What it checks",
  recountChecksTitle: "{count} groups of checks, from the code to the count",
  recountChecksLede:
    "Each is set out in the verifier's specification, which is enough to write a verifier of your own in any language. A check it can't make is reported, never passed.",
  recountCheck1Title: "The ballot app and the contracts",
  recountCheck1Body:
    "The ballot app a site serves is a signed release, and every contract the poll uses is the release's build of reviewed code.",
  recountCheck2Title: "The poll's definition",
  recountCheck2Body:
    "Its questions, answers, window, electorate and trustees are the ones registered before it opened, and nothing about them changed since.",
  recountCheck3Title: "The key ceremony",
  recountCheck3Body:
    "The trustees' keys were made in public, every proof in the record of it holds, and enough seats took part.",
  recountCheck4Title: "The board, its anchors and the archive",
  recountCheck4Body:
    "Every entry sits in its place in one unbroken chain, every checkpoint matches its anchor on Ethereum, and the archive holds what the anchors name.",
  recountCheck5Title: "The ballots",
  recountCheck5Body:
    "Each ballot proves its voter is in the electorate without saying who, holds one valid set of answers and arrived inside the poll's window.",
  recountCheck6Title: "Re-voting and checked ballots",
  recountCheck6Body:
    "Only each voter's latest ballot can count, and no ballot opened to check the app is ever counted.",
  recountCheck7Title: "The count",
  recountCheck7Body:
    "The totals are worked out again from the counted ballots alone, and every published opening of a total must match them.",
  recountCheck8Title: "The report",
  recountCheck8Body:
    "Results come per tier, never added across tiers, with small counts flagged and everything it couldn't check listed.",
  recountTrustMark: "What it trusts",
  recountTrustTitle: "What it takes on trust, and what it doesn't",
  recountTrustLede:
    "A result is only as good as the inputs it was checked against, so the report names every input nothing proved, and the verdict falls short of verified while there is one.",
  recountTrustServers: "Our servers",
  recountTrustServersMeans:
    "Nothing. The verifier never asks our servers or domains for anything, except, when you ask it to check a served ballot app, the app itself, which it then judges byte by byte.",
  recountTrustL1: "Your Ethereum node",
  recountTrustL1Means:
    "Which block is final. The anchors and everything else read from Ethereum are proven against that block.",
  recountTrustL2: "Your node of the poll's network",
  recountTrustL2Means:
    "The records it holds up to its final block, such as the poll's definition. What a proof doesn't cover is named in the report.",
  recountTrustGateways: "IPFS gateways",
  recountTrustGatewaysMeans:
    "Nothing about the board: every block is checked against its address, so a gateway can only fail to answer. It does see which blocks, and so which poll, you read.",
  recountNodeMark: "Community node",
  recountNodeTitle: "Run a node, keep a copy",
  recountNodeLede:
    "The community node in the commands above is the verifier, a copy of the boards and a chain reader, with no database and no account. Each one left running is another copy of the record that doesn't depend on us.",
  recountNodeServeTitle: "Serve your copy",
  recountNodeServeBody:
    "From the same checkout, after the boards are copied, this hands out every block the node holds, by its address, and the reports the verify step wrote.",
  recountNodeOpen:
    "It listens only on your own machine unless you tell it otherwise. Opened to others, put a proxy in front that limits each address: on its own, one visitor can hold every connection.",
  recountNodeKeeps: "Keeps",
  recountNodeKeepsMeans:
    "The board files the copy step fetched, each block checked against its address. It adds to them only when you run that step again.",
  recountNodeServes: "Serves",
  recountNodeServesMeans:
    "Each block it holds to any IPFS client that asks, and each poll's latest report. It writes nothing down about who asked for what.",
  recountNodeVerifies: "Verifies",
  recountNodeVerifiesMeans:
    "Every poll the anchors name, each time you run the verify step. It doesn't run that on its own yet.",
  recountNodeNeeds: "Needs",
  recountNodeNeedsMeans:
    "A machine left on, an Ethereum node, a node of the poll's network, and disk for the boards you copy. Restart it to serve what a later copy added.",
  recountSource:
    "The verifier's source is in packages/verifier and its specification in docs/spec/verifier.md, both published at github.com/abolishus/abolish.",
  navKeys: "Who holds the keys",
  keysEyebrow: "Trustees · The launch panel",
  keysTitle: "During launch, Abolish alone holds the key",
  keysLede:
    "Every answer is sealed so that only a poll's trustee seats, working together, can open it. Until independent trustees are named, every seat is ours, so for now the answers to a poll here are not secret from us.",
  keysFigureSeats: "Trustee seats",
  keysFigureSeatsScope: "every one run by Abolish",
  keysFigureThreshold: "Needed to open a count",
  keysFigureThresholdScope: "any {threshold} of the {seats}",
  keysFigureAlone: "Seats that can open anything alone",
  keysFigureAloneScope: "a share by itself reveals nothing",
  keysFigureOthers: "Seats held by anyone else",
  keysFigureOthersScope: "until independent trustees are named",
  keysSeatsMark: "The seats",
  keysSeatsTitle: "{seats} seats, and any {threshold} open a count",
  keysSeatsLede:
    "A seat is a trustee's node. When you answer, the ballot app splits what opens your sealed answer into one share for each seat, each encrypted to that seat alone.",
  keysSeat1Title: "No seat opens anything alone",
  keysSeat1Body:
    "One share, or any {fewer} of them, reveals nothing about an answer. No single seat can open a count early, or at all.",
  keysSeat2Title: "{threshold} seats open the totals",
  keysSeat2Body:
    "After a poll closes, each seat adds up its shares and {threshold} of those sums open each total. Every opening is signed by the seat that made it and checked against the board, so a wrong one shows in public.",
  keysSeat3Title: "The same {threshold} could open one answer",
  keysSeat3Body:
    "Seats that meet the threshold together could open single answers, not only totals. That is why it matters who holds them, and why each poll's page says how many it takes.",
  keysOursMark: "During launch",
  keysOursTitle: "For now, every seat is ours",
  keysOursLede:
    "Independent trustees aren't named yet, so the launch panel's seats are all run by Abolish. Here is what that means, stated plainly.",
  keysOursCould: "What we could do",
  keysOursCouldMeans:
    "Open any single answer to a poll under the launch panel, while it runs and until its shares are destroyed.",
  keysOursShows: "What an opened answer shows",
  keysOursShowsMeans:
    "What one anonymous voting identity answered, not who it is, unless it is joined to the network address the ballot arrived from. Our seats receive each ballot with that address and promise not to keep it, a promise no one can check.",
  keysOursCompel: "Who could make us",
  keysOursCompelMeans:
    "Anyone who can compel us, by law or by force, could make us open answers or hand over the shares before they are destroyed.",
  keysOursPolls: "Which polls",
  keysOursPollsMeans:
    "Only everyday polls. Civic referendums and organisational votes wait for an independent panel, and every poll's page says who holds its key.",
  keysPromiseMark: "What we promise",
  keysPromiseTitle: "Our commitments, and what no one can check",
  keysPromiseLede:
    "These are promises, not proofs. Where something can be checked, it says how; where it can't, it says that too.",
  keysPromise1Title: "Separate machines, providers and keyholders",
  keysPromise1Body:
    "No one machine, hosting provider or person who can reach a seat holds {threshold} seats. That guards against one breach or one rogue insider, not against anyone who can compel Abolish itself.",
  keysPromise1Check: "No one outside can check this.",
  keysPromise2Title: "Shares destroyed after each final count",
  keysPromise2Body:
    "Once a poll's final count is published, each seat destroys its keys and shares and signs a statement saying it has.",
  keysPromise2Check:
    "The signed statements are on the poll's board. The destruction itself can't be checked by anyone.",
  keysPromise3Title: "Said on every poll",
  keysPromise3Body:
    "Every poll's page says that during launch, Abolish alone holds the key for that poll, in the everyday pages as well as the evidence.",
  keysPromise3Check: "Anyone can see it on each poll's page.",
  keysNextMark: "What comes next",
  keysNextTitle: "Independent trustees, before the first civic vote",
  keysNextLede:
    "The launch panel is meant to end. Until it does, this page says so rather than showing trustees who don't exist yet.",
  keysNext1Title: "The handover",
  keysNext1Body:
    "Seats move to named, independent trustees before any civic referendum runs, each move a new panel pinned on chain and in a new release. A handover protects only polls opened after it: polls opened before stay readable with our shares until we destroy them.",
  keysNext2Title: "Your own trustees",
  keysNext2Body:
    "Askers will be able to add trustees of their own to a poll. Its answers then open only with the launch panel and the asker's trustees together, which protects that poll from us. The poll form doesn't offer it yet.",
  keysNext3Title: "Names and the key ceremony",
  keysNext3Body:
    "Once independent trustees are named, this page lists each one, where they are and the public record of the ceremony that made their keys.",
  keysMore:
    "What else is weak, and how to check a count without us, is set out on the pages below.",
  keysMoreWeak: "Where it is weak, stated plainly",
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
    "Open questions from neighbours, groups and schools. Nothing here is ranked by clicks, by arguments or by anything about you: every order below is the same for everyone.",
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
  // The order counts the last seven days' answers, every tier together, and
  // each card its own since it opened, tier by tier (T-01): unsaid, a card
  // showing more than the one above it read as an order gone wrong (P2-29,
  // the stream's iteration 32).
  sortNote_answered:
    "Open now, the most answered in the last seven days first, each person counted once. A card counts every answer since it opened, so it can show more than the one above it.",
  streamQuestions: "Questions",
  streamAnsweredSoFar: "Answered so far",
  streamAnsweredSinceDay: "Answered since it opened {day}",
  streamAnsweredSinceDate: "Answered since it opened {date}",
  streamAnsweredNone: "No one yet",
  streamAnsweredUnread: "We couldn't get how many have answered just now.",
  streamAnswered_email: {
    one: "{count} person with a verified e-mail",
    other: "{count} people with a verified e-mail",
  },
  streamAnswered_phone: {
    one: "{count} person with a verified e-mail and phone",
    other: "{count} people with a verified e-mail and phone",
  },
  streamAnswered_vouched: {
    one: "{count} person vouched for by others",
    other: "{count} people vouched for by others",
  },
  streamAnswered_document: {
    one: "{count} person verified with a passport or ID",
    other: "{count} people verified with a passport or ID",
  },
  streamCloses: "Closes",
  streamPick: {
    one: "Choose an answer to open it in the ballot app. Nothing is sent until you cast your ballot there.",
    other:
      "Choose an answer to question 1\u00a0of\u00a0{count} to open it in the ballot app. Nothing is sent until you cast your ballot there.",
  },
  streamPickFirst: "These answers are for question 1\u00a0of\u00a0{count}.",
  streamNoBallot: "Answering from this page isn't set up on this site yet.",
  streamUnreadable: "This poll can't be shown here",
  streamUnreadableId: "Poll {prefix}…",
  streamText: "We couldn't read its question. Its own page has everything we hold about it.",
  streamUndecodable:
    "Its details came through damaged, so its question and answers can't be trusted here. Its own page says more.",
  streamMismatch:
    "Its details belong to a different poll, so its question and answers can't be trusted here. Its own page says more.",
  streamEmpty: "No open questions just now",
  streamEmptyLede: "When someone asks one, it shows up here.",
  streamMore: "More questions",
  streamSortUnavailableTitle: "This order isn't available just now",
  streamSortUnavailable: "The server can't count this week's answers at the moment.",
  streamSortUnavailableAction: "Show the newest questions",
  streamCursorLostTitle: "That page has moved on",
  streamCursorLost: "The question this page started after can't be placed in this order any more.",
  streamStart: "Start from the top",
  streamLater: "These come after the first page.",
  streamEndTitle: "That was the last of them",
  streamEnd: "Every open question in this order was on the pages before this one.",
  streamSearchLabel: "Search the questions",
  streamSearchHint:
    "Every word you type must appear in a question or its title, up to {words} words. Results keep the order below.",
  streamSearchSubmit: "Search",
  streamSearching: "Only questions with all your words.",
  streamSearchClear: "Clear the search",
  streamSearchEmpty: "No open question matches",
  streamSearchEmptyLede:
    "Try fewer words, or shorter ones: a question matches only when it holds every one.",
  streamSearchRefusedTitle: "That search can't be run",
  streamSearchRefused: "A search is one to {words} words, in at most {characters} characters.",
  listedUnder: "Where it's listed",
  streamTagsNote:
    "Askers choose their poll's topic and place. They aren't part of the poll, and moderation can change them if they don't fit.",
  streamNarrow: "Topic and place",
  streamPlaceSubmit: "Find",
  streamPlaceLabel: "Place",
  streamPlaceHint:
    "A town, neighbourhood or school, as askers write it. Capitals and spacing don't matter, but the whole name must match.",
  placeSuggested: "It suggests the places listed polls are filed at.",
  streamPlaceFiltering: "Only questions filed at this place.",
  streamPlaceClear: "Clear the place",
  streamTopicClear: "Show every topic",
  streamFilterEmpty: "No open question is filed here",
  streamTopicEmptyLede: "Only questions filed under this topic are listed.",
  streamPlaceEmptyLede: "Only questions filed at this place are listed.",
  streamTopicPlaceEmptyLede:
    "Only questions filed under this topic and at this place are listed. This topic may have more elsewhere.",
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
  listCounted: "counted",
  listClosed: "On",
  listPoll: "Poll",
  listCounting: "Counting",
  listKind: "Kind",
  listKindCounting: "Kind and counting",
  listStatus: "Status",
  fingerprintPoll: "Fingerprint of poll {prefix}",
  status_open: "Open",
  status_scheduled: "Scheduled",
  status_closed: "Closed",
  registerEyebrow: "Register of polls",
  registerTitle: "Every listed poll",
  registerCounts: "The list in numbers",
  registerCountListed: "Listed polls",
  registerCountOpen: "Open now",
  registerCountScheduled: "Scheduled",
  registerCountAsOf: "As of",
  registerLookupTitle: "Open a poll by its ID",
  registerFindTitle: "Find a poll",
  registerFindLede:
    "Search every listed poll by its words, topic or place, then filter the page of the list by status and counting rule. Leave a group at All to include all of it.",
  registerSearchLabel: "Search the polls",
  registerSearchHint:
    "Every word you type must appear in a poll's title or questions, up to {words} words. Open, scheduled and closed polls are all searched, in the list's order.",
  registerSearching: "Only the polls that hold every word you searched for.",
  registerSearchEmpty: "No listed poll matches",
  registerSearchEmptyLede:
    "Try fewer words, or shorter ones: a poll matches only when its title or questions hold every one. A poll that moderation has delisted isn't searched, but it stays open by its ID.",
  registerTopicLabel: "Topic",
  registerFiledTopic: "Only the polls filed under {topic}.",
  registerFiledPlace: "Only the polls filed at the place you gave.",
  registerFiledEmptyLede:
    "A poll is filed under a topic or at a place only where its asker, or moderation, filed it, and a place matches only by its whole name. A poll that moderation has delisted isn't listed, but it stays open by its ID.",
  registerAsOf:
    "Statuses come from each poll's stated opening and closing times, read against this server's clock ({time} UTC).",
  filterAll: "All",
  filterApply: "Show matching polls",
  filterClear: "Clear filters",
  registerMatches: "{shown} of {total} polls on this page match.",
  registerPages: "Pages of the list",
  registerFirst: "First page",
  registerPrevious: "Previous page",
  registerPastEnd: "No more polls",
  registerPastEndLede:
    "The list ends before this page. It runs in order of poll ID, so a poll listed since you started may be on an earlier page.",
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
    "Answers are cast only in the ballot app, never on this website, and each is sealed on the voter's own device before anything is sent.",
  pollAnswerOpen: { one: "Answer the question", other: "Answer {count} questions" },
  pollAnswerScheduled: "You can answer here once the poll opens.",
  pollScheduledLede:
    "Nothing can be answered until it opens. Who can answer, when, and how it's counted are set out below.",
  pollOpenLede: {
    one: "One question. You can change your answer until the poll closes, and only your last one counts.",
    other:
      "{count} questions, answered together. You can change your answers until the poll closes, and only your last ones count.",
  },
  pollFactsTitle: "About this poll",
  pollQuestionsTitle: "What it asks",
  pollQuestionsFixed:
    "The poll's definition fixes these words, so they can't be edited before it opens or while it runs.",
  pollPickFrom: "{instruction} from {options}",
  pollPickRule: "{instruction}. {pick}",
  pollFinal: {
    one: "Final results. {count} person answered; here is what they said.",
    other: "Final results. {count} people answered; here is what they said.",
  },
  pollInShort: "In short",
  pollAnsweredClosed: "Answered before it closed",
  pollAnswerClosed: "This poll has closed and takes no more answers.",
  resultsTitle: "Results",
  resultsEachQuestion:
    "Each question is counted on its own. Answers to different questions are never matched up: only each question's totals are opened, so no result shows how anyone answered the set.",
  resultsSealed:
    "Answers stay sealed while the poll is open. The results appear here once they're counted.",
  resultsSealedTitle: "Results appear when it closes",
  resultsSealedUntil:
    "The answers stay sealed until the poll closes on {when}. The results appear here once they're counted.",
  resultsSealedUntilClose:
    "The answers stay sealed until the poll closes. The results appear here once they're counted.",
  resultsSealedAsker:
    "Until then whoever asked it can't see them either: only the poll's trustee seats can open the count, and during launch Abolish runs every seat.",
  resultsSealedBoard:
    "Anyone can count the sealed answers on the poll's public board; what they say stays locked.",
  resultsCounting: "This poll has closed. The results appear here once its answers are counted.",
  resultsNotCounted:
    "This server doesn't publish this poll's results. Anyone can still count them from its public board.",
  resultsUnavailable: "The results couldn't be loaded just now. Try again in a little while.",
  resultsAnswered: { one: "{count} person answered", other: "{count} people answered" },
  resultsNoneAnswered: "No one answered.",
  resultsTurnout: "Turnout",
  resultsTierMeaning_email:
    "Each account here showed it holds an e-mail address. Anyone with several addresses can open several accounts, so this group counts accounts, not people, and is never added to another.",
  resultsTierMeaning_phone:
    "Each account here showed it holds an e-mail address and a phone number, and a number verifies one account only. Someone with several numbers can still open several accounts, so this group counts accounts, not people, and is never added to another.",
  resultsTierMeaning_vouched:
    "Each member was vouched for by people already verified, so faking one takes others willing to vouch falsely.",
  resultsTierMeaning_document:
    "Each member proved on their own phone, without showing it, that they hold a government-signed passport or ID, and the same document can't join twice. Someone with two documents can still join twice, so this group counts documents, not people, and is never added to another.",
  resultsTurnoutOf: { one: "{share} of {count} member", other: "{share} of {count} members" },
  resultsTurnoutOfClose: {
    one: "{share} of {count} person who could answer by the close",
    other: "{share} of {count} people who could answer by the close",
  },
  resultsCouldAnswer: {
    one: "{count} person could answer by the close",
    other: "{count} people could answer by the close",
  },
  resultsFewCouldAnswer:
    "So few could answer that these results can show how some of them answered.",
  resultsFewCouldAnswerShort: "Few could answer",
  resultsTurnoutIs: "Turnout: {turnout}",
  resultsTierPending:
    "Part of this group's count isn't published yet. Its results appear here once it all is.",
  resultsLeader: "Most picked: {option}, by {share} of those who answered.",
  resultsTied: "Tied for most picked: {option}, each by {share} of those who answered.",
  resultsNothingPicked: "No answer was picked.",
  resultsOption: "Answer {number}",
  resultsPeople: { one: "{count} person", other: "{count} people" },
  resultsClaim:
    "These are the results our server reads from the count published on the poll's public board. Nothing on this page checks them for you: anyone can count the board again and compare.",
  resultsCheck: "Check the count on the board",
  resultsUpFront:
    "Everything below is what our server says about this poll. Anyone can count its board again without us, and compare.",
  resultsUpFrontLink: "How to check it yourself",
  resultsSeeAll: "See the full results",
  resultsPageTitle: "Results",
  resultsPageEyebrow: "Poll {prefix}… · Results",
  resultsPageLede:
    "Each group is counted and reported on its own, and so is each question. No figure on this page adds two groups or two questions together.",
  resultsByGroup: "Results by group",
  resultsSideBySide: "The groups side by side",
  resultsSideBySideCaption:
    "One column per group. There is no total column: the groups are never added together.",
  resultsAnswer: "Answer",
  resultsAnswers: "Answers",
  resultsNotAllPublished: "Not all published yet",
  resultsCellsTitle: "Part by part",
  resultsCellsLede: {
    one: "This group is counted in {count} part.",
    other:
      "This group is counted in {count} parts, each published on its own. Its results above are their sum.",
  },
  resultsCell: "Part",
  resultsCellName: "Part {number}",
  resultsRegion: "region {number}",
  resultsCellMissing: "Not published yet",
  resultsCellFailed: "Didn't pass the board's check",
  resultsCellsUnavailable: "This group's parts couldn't be shown just now.",
  resultsOpeningsTitle: "Who opened the count",
  resultsOpeningsLede:
    "Each part of the count is opened by one of this poll's {size} trustee seats, once at least {threshold} of them have added their shares. The seat that opens it signs the opening, so the board shows which seat it was. During launch, Abolish runs every seat.",
  resultsOpeningsPart: "Part of the count",
  resultsOpenedBy: "Opened by",
  resultsSeats: { one: "Seat {seats}", other: "Seats {seats}" },
  resultsOpenedUnsigned: "No seat's signature on it checks",
  resultsStatusCounted: "Counted",
  resultsFingerprints:
    "Counting it again without us starts from this poll's ID, and the definition it finds must have this hash, which fixes the poll's rules before its first answer.",
  resultsCheckTitle: "Check it yourself",
  resultsBoardTitle: "What the board holds",
  resultsBoardLede:
    "This poll's results are counted from its public board. Entries are only ever added at the end, and none shows how anyone voted.",
  resultsBoardUnavailable: "The board couldn't be read just now.",
  resultsVerify: "How to count it yourself",
  resultsReceiptTitle: "Your receipt",
  resultsReceiptBody:
    "If you answered, your receipt is kept by the ballot app on the device you answered from. It shows that your ballot is on this poll's board, not how you answered.",
  resultsReceiptCheck:
    "This page doesn't look a receipt up: asking our server for your entry would tell it which one is yours. To check yours, copy the whole board, as How to count it yourself sets out, and find your entry in your copy.",
  resultsRecountTitle: "Count this poll again",
  resultsRecountBody:
    "Once the community node has copied and verified the boards, as How to count it yourself sets out, the verifier checks this poll on its own with this command. Its exit code is the verdict.",
  reactionsTitle: "Reactions",
  reactionsLede:
    "React to the poll itself. A reaction isn't an answer and says nothing about whether you answered.",
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
  followTitle: "Follow",
  followLede:
    "Get an e-mail when its results are in. Following isn't answering and says nothing about whether you answered.",
  followJoin: "Follow this poll",
  followStop: "Stop following",
  followFollowing: "You're following this poll.",
  followStopped: "You've stopped following this poll.",
  followPrivacy: "Only you can see that you follow it. No one sees how many people do.",
  followSignIn: "Sign in",
  followSignedOut: "Following needs a signed-in account.",
  followVerify: "Verify your e-mail",
  followUnverified: "Following needs a verified e-mail address, where we'd write to you.",
  followHidden: "This poll is hidden, so it can't be followed.",
  followTooManyThisHour:
    "You've followed and stopped following as often as you can this hour. Try again later.",
  followFailed: "That didn't go through. Try again shortly.",
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
  ogMostPicked: "Most picked",
  ogTiedPicked: "Tied for most picked",
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
  // Trustees are invisible in an everyday poll (PROJECT_BRIEF, Non-negotiable
  // properties): a reason names what failed, never who.
  pollFailure_closesTooSoon:
    "Setting up took longer than expected, and your poll would have closed too soon after opening. Choose a later closing time and submit it again.",
  pollFailure_creationReverted:
    "Your poll couldn't be created on the public record. Your question wasn't published. You can submit it again or discard it.",
  pollFailure_creationReplaced:
    "Something went wrong on our side while your poll was being created, so we stopped. Your question wasn't published. You can submit it again or discard it.",
  pollFailure_creationTimeout:
    "Creating your poll on the public record took too long. Your question wasn't published. You can submit it again or discard it.",
  pollFailure_creationAnchored:
    "Your poll couldn't get a clean start on the public record after three tries, so its answers couldn't be protected. Your question wasn't published. You can submit it again or discard it.",
  pollFailure_tierUnavailable:
    "Polls can't be set up yet for the voters you chose. Your question wasn't published. Change who can answer and submit it again.",
  pollFailure_electorateEmpty:
    "Nobody could have answered: no one was yet in the group of voters you chose when your poll was set up. Your question wasn't published. You can submit it again later or discard it.",
  pollFailure_stubRefused:
    "Something went wrong on our side while your poll was being prepared. Your question wasn't published. You can submit it again or discard it.",
  pollFailure_registrationRefused:
    "Your poll's setup didn't pass our checks, so we didn't register it. Your question wasn't published. You can submit it again or discard it.",
  pollFailure_registrationReverted:
    "The public record refused to register your poll. Your question wasn't published. You can submit it again or discard it.",
  pollFailure_registrationReplaced:
    "Something went wrong on our side while your poll was being registered, so we stopped. Your question wasn't published. You can submit it again or discard it.",
  pollFailure_registrationTimeout:
    "Registering your poll took too long. Your question wasn't published. You can submit it again or discard it.",
  pollFailure_registrationMismatch:
    "Something other than your poll was registered under its place on the public record, so we stopped before it opened. It will never take answers, and it stays on the record. You can ask your question again as a new poll, starting from what you wrote.",
  pollFailure_openMismatch:
    "What the public record holds for your poll isn't exactly what you wrote, so we didn't open it. It will never take answers, and it stays on the record. You can ask your question again as a new poll, starting from what you wrote.",
  pollFailure_ceremonyTimeout:
    "Making the key that seals your poll's answers didn't finish after four tries. Your question wasn't published. You can submit it again or discard it.",
  pollFailure_openTimeout:
    "Your poll was registered but couldn't open before its closing time. It will never take answers, and it stays on the record. You can ask your question again as a new poll, starting from what you wrote.",
  evidenceSummary: "How do we know this is real?",
  evidenceLede:
    "Every answer is listed on the public board, which anyone can download and count again.",
  evidenceLedeClosed:
    "Every answer was sealed on the device that sent it and listed on the public board, which anyone can download and count again.",
  evidenceKey:
    "Whoever asked it can't see anyone's answers. During launch, Abolish alone holds the key for this poll.",
  evidenceShow: "Show the evidence",
  evidenceHide: "Hide the evidence",
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
  factKind: "Kind",
  class_everyday: "Everyday poll",
  class_organisational: "Organisational vote",
  class_civic: "Civic referendum",
  pollCivicRecord:
    "Its definition puts it on the civic record, which takes only polls whose key is held by independent trustees. None are named yet, so the election registry on chain refuses to register a poll like this one.",
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
  groupMembersAtOpening: {
    one: "{count} member when it opened",
    other: "{count} members when it opened",
  },
  rollingTier0: "Open to new identities until it closes",
  rollingTier: "Open to new members until it closes",
  boardTitle: "Public board",
  boardEntries: "Entries",
  boardEmpty: "No entries yet.",
  boardHead: "Chain head",
  boardHeadMeaning: {
    one: "The chain head is the latest entry's link, and each link hashes in the one before it, so the head commits to every entry in order. Two copies of this board with the same head hold the same single entry.",
    other:
      "The chain head is the latest entry's link, and each link hashes in the one before it, so the head commits to every entry in order. Two copies of this board with the same head hold the same {count} entries.",
  },
  boardRoot: "Tree root",
  boardUnanchored:
    "Until an L1 checkpoint covers these values, they are only this server's word. Keep them: a later board that doesn't extend them is evidence of tampering.",
  boardHeadHistory:
    "The tree root above and the latest checkpoint's are one history: this page checked that the smaller tree is the start of the larger, by our server's consistency proof, or by the same root at the same size.",
  boardHeadHistoryBroken:
    "The tree root above and the latest checkpoint's are not one history: our server couldn't prove that the smaller tree is the start of the larger. Keep both. One board with two histories is evidence of tampering.",
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
  boardKindLegend: "Kind",
  boardKindApply: "Show entries of this kind",
  boardKindMatches: "{shown} of the {total} entries on this page are of this kind.",
  boardKindNone: "No entries on this page are of this kind. Earlier or later pages may have some.",
  boardPages: "Pages of the board",
  boardEarlier: "Earlier entries",
  boardLater: "Later entries",
  boardLatest: "Latest entries",
  boardInTree: {
    one: "The {count} entry on this page that the tree root above covers is in that tree: this page checked our server's inclusion proof for it against the root.",
    other:
      "The {count} entries on this page that the tree root above covers are each in that tree: this page checked our server's inclusion proof for each one against the root.",
  },
  boardOutsideTree:
    "Entry {entry} isn't in the tree whose root is above: our server couldn't prove that it is. Keep this page. An entry shown outside the board its root commits to is evidence of tampering.",
  boardOwnEntry:
    "This page doesn't look up a receipt's entry: asking our server for your own entry would tell it which one is yours, and each page here covers 25 entries so that browsing tells it less. To check your receipt, download the whole board and look for your entry there, where no one learns which one you looked for.",
  boardEntriesUndecodable:
    "Our server sent entries for this poll's board that don't check: one doesn't decode under the poll's definition, names another poll or sits at another place. This page shows none of them rather than show a board it can't read. Its board is unaffected wherever else it is copied.",
  fingerprintHead: "Fingerprint of the chain head {prefix}",
  fingerprintEntry: "Fingerprint of entry {entry}",
  boardActivityMark: "Activity",
  boardActivityTitle: "Entries per period",
  boardActivityLede:
    "How many entries the board added in each of its latest anchoring periods, an hour each, worked out from the checkpoints below: each count is how many more entries a period's checkpoint holds than the checkpoint before it. A period with no checkpoint added nothing.",
  boardActivityClaim:
    "These counts are worked out here from our server's checkpoints, so they are only as good as those are. The verifier counts every period from the board and its anchors.",
  boardActivityChart:
    "Entries per period, periods {first} to {last}: {total} entries in all. Every period is in the table below.",
  boardActivityPeriod: "Period {segment}",
  boardActivityMost: "Most in one period: {count}",
  boardActivityTable: "The count for each period",
  boardActivityCaption: "Entries added in each period, earliest first",
  boardActivityColumnPeriod: "Period",
  boardActivityColumnAdded: "Entries added",
  boardActivityNone:
    "No period's entries can be counted yet: that takes a checkpoint, and the one before it or the board's first.",
  boardActivityUndecodable:
    "Without checkpoints that check, this page can't count the board's entries per period.",
  boardAnchorsMark: "Anchors",
  boardAnchorsTitle: "Checkpoints for Ethereum",
  boardAnchorsLede:
    "After each hour that added entries, our server takes a checkpoint of the board: how many entries it holds, its chain head and its Merkle root at the end of that hour. Anchoring puts its hash into the anchor contract on Ethereum, and from then on an altered entry no longer matches it. A checkpoint is taken before it is anchored, and until the anchor holds it, it is only our word.",
  boardAnchorsClaim:
    "These checkpoints come from our server. This page decodes each one, checks that it names this poll and that each earlier one holds no more entries, and computes its hash itself. It also checks our server's consistency proofs that each checkpoint shown extends the one before it. It doesn't check that any of them is anchored, or that it matches the entries: that is for the verifier, which reads the anchor and the whole board itself.",
  boardAnchorsList: "Checkpoints, latest first",
  boardAnchorPeriod: "After period {segment}",
  boardAnchorLatest: "Latest",
  boardAnchorSize: "Entries by then",
  boardAnchorHash: "Checkpoint hash, the value to anchor",
  boardAnchorHead: "Chain head by then",
  boardAnchorRoot: "Merkle root by then",
  boardAnchorExtends:
    "Extends the checkpoint after period {segment}: this page checked it, by our server's consistency proof between the two, or by the same root at the same size.",
  boardAnchorBroken:
    "Doesn't extend the checkpoint after period {segment}: our server couldn't prove that it does. Keep both. One board with two histories is evidence of tampering.",
  boardAnchorsNone: "No checkpoint has been taken of this board yet.",
  boardAnchorsMore:
    "Only the latest {count} checkpoints are shown here. The verifier reads every anchored one, from the first.",
  boardAnchorsUndecodable:
    "Our server sent checkpoints for this board that don't check: one doesn't decode, names another poll, or holds more entries than a later one. This page shows none of them rather than show checkpoints it can't read.",
  boardCeremonyMark: "Key ceremony",
  boardCeremonyTitle: "How the poll's key was made",
  boardCeremonyLede:
    "Before a poll opens, its trustee seats make the key its answers are sealed to, in four rounds of signed messages: their keys, challenges, answers and reveals. The record of all four is the board's first entry, and the poll's definition commits to its hash.",
  boardCeremonyClaim:
    "This page decodes that record, computes its hash itself and compares it with the definition's, and reads which seats sent a message in each round. It doesn't check the proofs in it, or so which seats qualified: that is for the verifier, which checks the record against the trustee panel our release names.",
  boardCeremonyCommitted:
    "This is the record the poll's definition commits to: this page computed its hash and found the definition's.",
  boardCeremonyNotCommitted:
    "This isn't the record the poll's definition commits to: its hash, computed here, isn't the definition's. Keep this page. A board whose ceremony doesn't match its poll fails the verifier.",
  boardCeremonyHash: "Ceremony record hash, computed here",
  fingerprintCeremony: "Fingerprint of the key ceremony's record",
  boardCeremonySeatsTitle: "Seats that sent all four rounds: {count} of {seats}",
  boardCeremonySeats: "Trustee seats, in order",
  boardCeremonySeat: "Seat {index}",
  boardCeremonyAllRounds: "All four rounds",
  boardCeremonySomeRounds: "{count} of the four rounds",
  boardCeremonyLaunch: "During launch, Abolish runs every seat.",
  boardCeremonyMissing:
    "The board's first entry isn't a ceremony record. A poll's board must start with one, so the verifier fails this poll.",
  boardCeremonyUndecodable:
    "The board's first entry doesn't decode as a ceremony record this page reads, under the version the poll's definition pins.",
  boardCeremonyEmpty: "The board holds no entries yet, so the ceremony's record isn't on it.",
  boardCeremonyElsewhere: "The ceremony's record is the board's first entry.",
  boardCeremonyFirstPage: "See it on the first page",
  fingerprintCheckpoint: "Fingerprint of the checkpoint after period {segment}",
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
  rule_results: "results schedule",
  "rule_civic-sealed": "sealed civic results",
  "rule_author-panel": "author's trustees",
  "rule_rolling-class": "who can join a civic poll",
  "rule_rolling-tier": "groups that can join",
  utcTime: "{time}\u00a0UTC",
  zonedTime: "{time}\u00a0{zone}",
  zonedDayTime: "{day}, {time}\u00a0{zone}",
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
  moderationLogTitle: "Decisions, newest first",
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
  moderationMore: "Earlier decisions",
  moderationLatest: "Latest decisions",
  moderationLater: "Later decisions",
  moderationActionApply: "Show these decisions",
  moderationActionMatches: "{shown} of the {total} decisions on this page took this action.",
  moderationActionNone: "No decision on this page took this action.",
  moderationActionEarlier: "Earlier decisions may have some.",
  moderationCounts: {
    one: "The whole log since {since}: {count} decision, by action",
    other: "The whole log since {since}: {count} decisions, by action",
  },
  moderationCountsShown: "Shown below",
  moderationPageOfLog: {
    one: "This page holds {shown} of the log's {count} decision.",
    other: "This page holds {shown} of the log's {count} decisions.",
  },
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
  moderationAppealOnce:
    "A creator can appeal a decision to delist or hide their poll, or to hide their profile, once, from their account. A moderator other than the one who decided reviews it.",
  moderationReportsMark: "Reports",
  moderationReportsTitle: "See a poll that breaks these rules?",
  moderationReportsLede:
    "Anyone can report a poll or a creator's profile, without an account, from its own page: choose the ground that fits and send it. Reports are counted, never who sent them, and a moderator judges what was reported against the grounds above: the number of reports never decides anything.",
  moderationReportsFind: "Find the poll in the register",
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
    "Each comes the next day, one e-mail a day at most, and says only that there's a decision or results to see. What was decided, and why, is here on this page and in the public moderation log, and which poll has its results is in your list below: we keep both out of the e-mail, so the service that delivers it learns as little as it can.",
  noticesResults: "Results of a poll you follow",
  noticesResultsHelp:
    "On unless you turn it off. Off, the poll still moves to your list below when its results are in; only the e-mail is left out. This is the same on every device you sign in on.",
  noticesResultsOn: "We'll e-mail you when a poll you follow has its results.",
  noticesResultsOff: "We won't e-mail you about results.",
  pushLabel: "Also notify this browser",
  pushHelp:
    "A notification on this device when the e-mail goes out, saying only that there's something to see here. Your browser's maker delivers it, so it learns that you use Abolish and the day it was sent.",
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
  pushNoticeTitle: "Something new on Abolish",
  pushNoticeBody:
    "A moderation decision, or results for a poll you follow. Open your account page to see which.",
  followResultsMark: "Followed polls",
  followResultsTitle: "Results for polls you followed",
  followResultsLede:
    "When a poll you follow has its results, it moves here, and unless you turned it off above, we tell you by e-mail without naming it. Only you can see this list.",
  followResultsEmpty:
    "Nothing here yet. When a poll you follow has its results, you'll find it here.",
  followResultsNoWords: "A poll whose words can't be shown",
  followResultsSee: "See the results",
  followResultsRemove: "Take it off this list",
  followResultsRemoved: "Taken off the list.",
  followResultsMore: "Show {count} more",
  followResultsReload: "Load the list again",
  followResultsFailure_unlisted: "This list couldn't be loaded just now.",
  followResultsFailure_more: "The rest of the list couldn't be loaded just now. Try again.",
  followResultsFailure_dropped: "That poll wasn't taken off the list. Try again.",
  followResultsFailure_signedOut: "You've been signed out. Sign in again to see this list.",
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
  exportHolds_follows: "The polls you follow, and those you followed whose results are in",
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
  profileAppeal_upheld: "upheld on {when}\u00a0UTC, and the profile restored",
  profileAppeal_rejected: "rejected on {when}\u00a0UTC",
  profileAppeal_superseded:
    "closed on {when}\u00a0UTC, because a later decision changed the profile first",
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
  profileChoiceLabelInList: "Show on your profile",
  profileChoiceHelp:
    "Your profile lists this poll, and its page says your profile asked it, while the poll is listed. Untick it at any time.",
  profileChoiceHelpUnsaved:
    "Saving the draft puts it on your profile. Your profile lists it, and its page says your profile asked it, once the poll is open and listed.",
  profileChoiceHelpUnopened:
    "Your profile lists this poll, and its page says your profile asked it, once the poll is open and listed. Untick it at any time.",
  profileChoiceShown: "Your profile shows this poll.",
  profileChoiceShownOnceOpen: "Your profile will show this poll once it opens.",
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
  pollReportTitle: "Something wrong with this poll?",
  pollReportHelp:
    "Anyone can report a poll, without an account. Reports are counted, never who sent them, and a moderator judges the poll against the policy: the number of reports never decides anything.",
  pollReport: "Report this poll",
  pollReportLegend: "Why should a moderator look at it?",
  pollReportGone: "This poll isn't on our server any more, so nothing was reported.",
  pollsMark: "Your polls",
  pollsTitle: "Polls you created",
  pollsLede:
    "Your drafts and every poll you submitted, whether it opened or not. Only you see this list: the public record never names who created a poll.",
  pollsEmpty: "You haven't created a poll yet.",
  pollsUntitled: "Untitled draft",
  pollsState_drafted: "Draft",
  pollsState_setup: "Setting up",
  pollsState_open: "Open",
  pollsState_failed: "Didn't open",
  pollsState_closed: "Closed",
  // A no-break space keeps "UTC" with its time (account-polls.tsx).
  pollsEdited: "Last edited {when}\u00a0UTC",
  pollsSubmitted: "Submitted {when}\u00a0UTC",
  pollsCloses: "Closes {when}\u00a0UTC",
  pollsClosed: "On {when}\u00a0UTC",
  pollsSetupHelp:
    "Setting up takes a while, mostly waiting for the public record to settle. Nothing more is needed from you: it opens on its own, and this list shows when it does, or why it didn't. You can also follow it step by step.",
  pollsFollowSetup: "Follow its setup",
  pollsPage: "Go to its page",
  pollsResults: "See its results",
  pollsAskAgain: "Ask it again",
  pollsDelete: "Delete draft…",
  pollsDeleteQuestion: "Delete this draft? This can't be undone.",
  pollsDeleteConfirm: "Delete draft permanently",
  pollsReload: "Load your polls again",
  pollsProfileIs: "Your profile is",
  pollsProfileHelp:
    "Ticking “Show on your profile” under a poll lists it on your profile, and its page says your profile asked it, while the poll is listed. A poll that hasn't opened yet is listed once it opens. Untick a box at any time.",
  pollsRetry: "Edit and submit again",
  pollsDiscard: "Discard…",
  pollsDiscardQuestion: "Discard this poll and its draft? This can't be undone.",
  pollsDiscardConfirm: "Discard permanently",
  pollsKeep: "Keep it",
  pollsRemoved: "The draft is deleted.",
  pollsDiscarded: "The poll is discarded.",
  pollsFailure_signedOut: "You've been signed out. Sign in again to see your polls.",
  pollsFailure_gone: "That poll is no longer here. The list is up to date now.",
  pollsFailure_changed: "That poll changed since the list was shown. The list is up to date now.",
  pollsFailure_registered: "That poll is registered on the public record, so it stays.",
  pollsFailure_tooManyDrafts:
    "You have as many drafts as an account can hold. Delete one, then try again.",
  pollsFailure_failed: "That didn't work. Nothing changed; try again shortly.",
  pollsFailure_unlisted: "Your polls couldn't be loaded just now.",
  pollsFailure_refused:
    "The server found a problem with that draft, so it wasn't saved. Check it and try again.",
  moderationOfPoll: "Moderation",
  moderationDecision: "{action}: {reason}, {when}\u00a0UTC",
  moderationDecisionWhat: "{action}: {reason}",
  moderationDecidedOn: "On {when}\u00a0UTC, decision No.\u00a0{seq}",
  moderationMeans_visible: "Our pages list and show this poll again.",
  moderationMeans_delisted:
    "Our pages don't list this poll, but it stays open at its address. The board, the count and the result aren't affected.",
  moderationMeans_hidden:
    "Our pages don't show this poll's text. The board, the count and the result aren't affected.",
  moderationAppealed: "You appealed decision No. {seq} on {when}\u00a0UTC: {outcome}.",
  moderationAppealPending: "waiting for a moderator other than the one who decided",
  moderationAppeal_upheld: "upheld on {when}\u00a0UTC, and the poll restored",
  moderationAppeal_rejected: "rejected on {when}\u00a0UTC",
  moderationAppeal_superseded:
    "closed on {when}\u00a0UTC, because a later decision changed the poll first",
  moderationAppeal: "Appeal this decision…",
  moderationAppealQuestion:
    "Appeal this decision? A moderator other than the one who decided reviews it. You can appeal a decision only once.",
  moderationAppealConfirm: "Send appeal",
  moderationAppealCancel: "Not now",
  moderationAppealFiled: "Your appeal is filed.",
  moderationFailure_signedOut:
    "You've been signed out. Sign in again to see this poll's moderation.",
  moderationFailure_gone: "That poll is no longer here.",
  moderationFailure_changed:
    "That decision changed or was already appealed since this page read it. This shows how it stands now.",
  moderationFailure_failed: "The appeal didn't go through. Nothing changed; try again shortly.",
  moderationFailure_unloaded: "This poll's moderation couldn't be loaded just now.",
  moderationReload: "Load its moderation again",
  moderationLogAt: "See it in the moderation log",
  moderationNone: "Moderation hasn't decided anything about this poll.",
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
  pollFormCopiedLede:
    "Your words from the poll that didn't open are filled in. Choose when this one closes; only you can see it until you submit it.",
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
  setupFailedNext: "Back to your polls, to submit it again or discard it",
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
  pollFormWhoTitle: "Who can answer?",
  pollFormWhoLede_email:
    "For now, every poll is open to the same people. Each verified e-mail address counts once, so someone with two addresses could answer twice: results count addresses, not people.",
  pollFormWhoLede_phone:
    "For now, every poll is open to the same people. Each verified phone number counts once, so someone with two numbers could answer twice: results count numbers, not people.",
  pollFormWho_email: "People with a verified e-mail address",
  pollFormWho_phone: "People with a verified e-mail address and phone number",
  pollFormWhenTitle: "When does it close?",
  pollFormWhenLede: "Choose a time on your own clock ({zone}), from 90 minutes to a year from now.",
  pollFormDateLabel: "Closing date",
  pollFormTimeLabel: "Closing time",
  pollFormUtc: "People answering see it as {when} UTC, the clock every poll keeps.",
  pollFormOpenFor:
    "Submitted now, it opens after about half an hour of setup and stays open for about {length}.",
  pollFormOpenDays: { one: "{count} day", other: "{count} days" },
  pollFormOpenHours: { one: "{count} hour", other: "{count} hours" },
  pollFormOpenDaysHours: "{days} and {hours}",
  pollFormPreviewTitle: "What people will see",
  pollFormPreviewEmpty: "Your poll's title",
  pollFormPreviewQuestionEmpty: "Your question",
  pollFormPreviewOptionEmpty: "An option",
  pollFormPreviewCloses: "Closes {when} UTC",
  // The ballot client's instructions and skip note (apps/ballot/src/messages.ts), word for word.
  pollFormPreviewChooseOne: "Choose one.",
  pollFormPreviewChooseAny: "Choose as many as you like.",
  pollFormPreviewChooseUpTo: "Choose up to {count}.",
  pollFormPreviewChooseExactly: { one: "Choose one.", other: "Choose exactly {count}." },
  pollFormPreviewChooseAtLeast: { one: "Choose at least one.", other: "Choose at least {count}." },
  pollFormPreviewChooseBetween: "Choose from {min} to {max}.",
  pollFormPreviewCantSkip: "This question can't be skipped.",
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
  pollFormReviewModeration: "What moderation can do",
  pollFormReviewModerationLede:
    "If your poll breaks one of the seven grounds in our moderation policy, a moderator can take it out of our lists or hide its words on our pages, and file it under another topic or place where one doesn't fit. Every decision goes in the public log, and you can appeal taking it out of the lists or hiding it once, from your account. Hiding an open poll for illegal content or someone's personal details also stops people answering it through our app until it's restored. Moderation never touches the answers or the count, and can't close your poll early.",
  pollFormReviewTitleRow: "Title",
  pollFormReviewDescription: "Description",
  pollFormReviewQuestions: "Questions",
  pollFormReviewQuestionCount: { one: "{count} question", other: "{count} questions" },
  pollFormReviewWho: "Who can answer",
  pollFormReviewCloses: "Closes",
  pollFormReviewPlace: "Place",
  pollFormReviewTopic: "Topic",
  pollFormReviewNone: "None",
  pollFormReviewNotSet: "Not set",
  pollFormReviewClosesAt: "{when} your time ({utc} UTC)",
  pollFormReviewUntitled: "No title yet",
  pollFormReviewNoDescription: "No description",
  pollFormReviewNoQuestion: "No question yet",
  pollFormReviewChange: "Change",
  pollFormSave: "Save draft",
  pollFormSaved: "Your draft is saved.",
  pollFormSubmitTitle: "Ready to ask?",
  pollFormSubmitLede:
    "Submitting sets your poll up on the public record, and it opens for answers when that's done, about half an hour later. It must then stay open for at least an hour. You can't change it after you submit.",
  pollFormSubmitCloudflare:
    "Before it's sent, a check by Cloudflare confirms you're a person. Cloudflare sees your browser's address while it runs.",
  pollFormSubmit: "Submit poll",
  pollFormSubmitAfterSave:
    "Save your draft first. Then you can check it through here and submit it.",
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
  pollFormInOption: "Question {n}, option {o}: {problem}",
  pollFormInField: "{field}: {problem}",
  pollFormInExplanation: "Question {n}, explanation: {problem}",
  pollFormInDetails: "Question {n}, details for option {o}: {problem}",
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
  pollForm_closesSkipped:
    "Your clock skips that time when it moves forward an hour. Choose another time.",
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

/**
 * What membership of a tier proved, under its name on a poll's results.
 * Tier 0 says what this deployment checks, as its name does, and that its
 * count is of accounts, not people (T-01); Tiers 1 and 2 say what their
 * proofs rule out and nothing more (T-02, T-03).
 */
export function tierMeaning(tier: Tier, phoneVerification: boolean): keyof Messages {
  if (tier === 0)
    return phoneVerification ? "resultsTierMeaning_phone" : "resultsTierMeaning_email";
  return tier === 1 ? "resultsTierMeaning_vouched" : "resultsTierMeaning_document";
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
