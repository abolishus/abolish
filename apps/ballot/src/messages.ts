import type { Message } from "@abolishus/ui";

import type { Locale } from "./locales.ts";
import { esUS } from "./messages.es-US.ts";

// The ballot client's own strings. Every locale's catalog has `en-US`'s type,
// so a missing key fails type-checking (@abolishus/ui, i18n).

const enUS = {
  // The frame (frame.tsx).
  name: "Abolish ballot",
  sealLabel: "Seal of this poll, {hash}",
  definitionLabel: "Fingerprint of the election definition {hash}",
  election: "Election {hash}",
  askedBy: "{name} asked",
  closes: "Closes {when}",
  questionOf: "Question {current} of {total}",
  stepOf: "Step {current} of {total}",
  stepNamed: "{step}: {name}",
  languageLabel: "Language",
  // What this client is, before any poll is open.
  title: "Abolish ballot",
  lede: "To vote, open the ballot link for your election.",
  localTitle: "Your answers stay on this device until they are sealed",
  local:
    "This page loads nothing from any other site, and your choices leave this device only encrypted.",
  // Refused on a shared origin (origin.ts).
  sharedOriginTitle: "This address isn't safe for voting",
  sharedOrigin:
    "This copy of the ballot is served from an address other sites share, so they could read it.",
  sharedOriginAddress: "The address you opened",
  nothingSentTitle: "Nothing was sent",
  nothingSent:
    "No ballot was shown and nothing you chose was sent. You haven't lost your chance to vote.",
  otherAddressTitle: "Open the ballot from another address",
  otherAddress: "Open the ballot from abolishus.eth or another address Abolish lists instead.",
  // Opening a poll from its link (open.tsx).
  checkingTitle: "Checking this poll",
  checking:
    "Before showing you anything, this device is checking the poll against the public election registry.",
  brokenLinkTitle: "This link doesn't open a poll",
  brokenLink:
    "Part of the link may be missing. Ask whoever sent it for the link again, or open the ballot from the poll's page.",
  noRegistryTitle: "This copy of the ballot can't check polls yet",
  noRegistry:
    "It names no election registry to check polls against, so it won't show any. Nothing was sent.",
  wrongChainTitle: "The election registry couldn't be read",
  wrongChain:
    "The network this device read from isn't the one this ballot checks polls on, so it stopped before showing anything.",
  notRegisteredTitle: "This poll isn't registered",
  notRegistered:
    "The public election registry has no poll with this link's number, or it was registered in the last half hour or so. Check the link, or try again later.",
  notFoundTitle: "This poll's questions aren't available",
  notFound:
    "The poll is registered, but the server didn't have its questions. Try again later, or open the ballot from another address.",
  withheldTitle: "This poll's wording is withheld",
  withheld:
    "Its questions are withheld under Abolish's moderation policy, so this device can't show them. Nothing was sent.",
  hiddenAsThreatTitle: "Hidden on Abolish's website as a threat",
  hiddenAsThreat:
    "A moderator hid this poll's wording on Abolish's website, citing a threat of violence. While the poll is open, this ballot still shows it, checked against the poll's registered fingerprint, so that hiding it doesn't stop anyone voting. Moderation never touches ballots or results.",
  unreachableTitle: "This device couldn't reach the servers",
  unreachable: "Check your connection and try again. Nothing was sent.",
  badAnswerTitle: "A server sent something that isn't a poll",
  badAnswer:
    "This device stopped before showing anything. Try again later, or open the ballot from another address.",
  workerFailedTitle: "This device couldn't check the poll",
  workerFailed: "The check stopped before it finished. Try again. Nothing was sent.",
  tryAgain: "Try again",
  answerAgain: "Answer again",
  // The arrival check (check.tsx).
  realPoll: "This is the real poll, checked",
  realPollExplained:
    "Before showing you anything, this device checked that these questions are exactly the ones registered for this poll. The seal is drawn from them; the poll's page shows the same one.",
  registeredFingerprint: "The poll's registered fingerprint",
  checksLabel: "Checks before voting",
  checksTitle: "What this device checked",
  passed: "Passed",
  failed: "Failed",
  ownOriginCheck: "It is running from an address of its own",
  ownOriginCheckDetail: "Served from {origin}, which no other site shares.",
  registeredCheck: "This is the election that was registered",
  registeredCheckDetail:
    "The election's definition has the same hash as the one in the public election registry. Its fingerprint is in the top bar.",
  registeredHash: "Registered definition hash",
  registeredFingerprintOf: "Fingerprint of the registered definition, {hash}",
  servedHash: "Hash of the definition this link served",
  servedFingerprintOf: "Fingerprint of the definition this link served, {hash}",
  // Refused after the election check (check.tsx); each failed check in words.
  refusedTitle: "Don't vote from this link",
  refused:
    "A check on the election this link opened failed, so this device stopped before showing a ballot. Nothing you chose was sent.",
  ruleBroken: "The rule it breaks, as the specification names it:",
  definitionUndecodable: "The election's definition can't be read",
  definitionUndecodableDetail:
    "What this link served as the election's definition isn't a valid record, so this device can't tell what the election is.",
  anotherElection: "The definition is for a different election",
  anotherElectionDetail: "The link names one election, and the definition it served names another.",
  unregisteredDefinition: "The election doesn't match the registry",
  unregisteredDefinitionDetail:
    "The definition this link served has a different hash from the one registered for this election. The two fingerprints below should be identical, and they are not.",
  definitionIllFormed: "The election's definition breaks the rules",
  definitionIllFormedDetail:
    "It matches the registry, but it breaks a rule every election must follow, so this device won't show it.",
  displayTextUndecodable: "The wording of the questions can't be read",
  displayTextUndecodableDetail:
    "What this link served as the questions and options isn't a valid record, so this device won't show it.",
  displayTextChanged: "The wording isn't the wording that was registered",
  displayTextChangedDetail:
    "The questions and options this link served aren't the ones the registered election committed to. Someone may have changed what an option says.",
  displayTextIllFormed: "The wording of the questions breaks the rules",
  displayTextIllFormedDetail:
    "The questions and options this link served break a rule every election's wording must follow, so this device won't show them.",
  panelUnpinned: "The poll's trustees aren't ones this ballot knows",
  panelUnpinnedDetail:
    "The poll names a panel of trustees this version of the ballot doesn't list, so this device can't tell whose keys it would encrypt your answers to.",
  ceremonyMissing: "The record of the trustees' keys isn't available",
  ceremonyMissingDetail:
    "This link didn't serve the public record of how the poll's trustees made their keys, so this device can't tell whose keys it would encrypt your answers to. The poll may be too new: try again later.",
  ceremonyFailed: "The trustees' key ceremony doesn't check",
  ceremonyFailedDetail:
    "The public record of how the poll's trustees made their keys is missing or fails a check, so this device won't encrypt your answers to those keys.",
  whatToDoTitle: "What you can do",
  whatToDoNoteTitle: "Try another address",
  whatToDo:
    "Open the poll from abolishus.eth or another address Abolish lists. If the check fails there too, tell whoever asked you to vote, and don't vote until it is fixed.",
  // The question screens (questions.tsx); each instruction from the question's limits (answers.ts).
  questionNumber: "Question {number}",
  checkStep: "Check your answers",
  chooseOne: "Choose one.",
  chooseAny: "Choose as many as you like.",
  chooseUpTo: "Choose up to {count}.",
  chooseExactly: { one: "Choose one.", other: "Choose exactly {count}." },
  chooseAtLeast: { one: "Choose at least one.", other: "Choose at least {count}." },
  chooseBetween: "Choose from {min} to {max}.",
  changeSingle: "To change your answer, choose a different one.",
  changeMulti: "To remove a choice, choose it again.",
  cantSkip: "This question can't be skipped.",
  selected: "Selected",
  chosenOf: "{count} of {max} chosen",
  moreAllowed: "{count} more allowed",
  noMoreAllowed: "No more choices left",
  nothingChosen: "Nothing chosen yet.",
  youChose: "You chose: {label}.",
  overvoteTitle: "You've already chosen {count}",
  overvote:
    "That's the most this question allows, so nothing changed. To choose “{label}”, first remove one of your other choices.",
  skipTitle: "Skip this question?",
  skipExplained:
    "A skipped question counts as no answer. Your other answers still count, and you can come back to this one before you send.",
  skipClears: "Skipping clears what you chose here.",
  skipAndGoOn: "Skip and go on",
  keepAnswering: "Keep answering",
  skipQuestion: "Skip this question",
  shortExactlyTitle: {
    one: "This question needs an answer",
    other: "This question needs exactly {count}",
  },
  shortAtLeastTitle: {
    one: "This question needs at least one",
    other: "This question needs at least {count}",
  },
  shortExplained: "Choose {count} more to go on.",
  nextQuestion: "Next question",
  toCheck: "Check your answers",
  back: "Back",
  // Check your answers (questions.tsx).
  checkTitle: "Check your answers",
  checkLede: "Nothing has been sent yet. Change anything you like.",
  answersLabel: "Your answers",
  skippedOne: "You skipped question {number}",
  skippedMany: "You skipped {count} questions",
  skippedExplained: "A skipped question counts as no answer. To answer it, use Change.",
  skippedAnswer: "Skipped: counts as no answer",
  unfitOne: "Question {number} needs an answer",
  unfitMany: "{count} questions need an answer",
  unfitExplained: "Those questions can't be skipped. To answer one, use Change.",
  change: "Change",
  changeLabel: "Change your answer to question {number}",
  seal: "Seal my answers",
  sealExplained:
    "Sealing encrypts your answers on this device. Nothing is sent: once they are sealed you choose whether to cast them or to check the encryption first.",
  // Finding the voter on the poll's list, then sealing (sealed.tsx).
  findingTitle: "Finding you on the poll's list",
  finding:
    "This device is reading the poll's public board to find your place among its members, without telling anyone which one is you. Nothing is sent.",
  sealingTitle: "Sealing your answers",
  sealing: "This device is encrypting your answers. Nothing is sent.",
  sealedTitle: "Your answers are sealed",
  sealed:
    "This device has encrypted your answers into a sealed ballot. Only enough of the poll's trustees acting together could open it. Nothing has been sent.",
  trackingCodeLabel: "Tracking code of your sealed ballot",
  trackingCodeQr: "QR code of the tracking code {hash}",
  trackingCodeFingerprint: "Fingerprint of the tracking code {hash}",
  scanTitle: "Scan it now with your other device",
  scan: "If you want to check this device, scan the code with another phone or computer before you choose. It keeps the code, so it can tell later whether this device opened the same ballot it showed you.",
  chooseTitle: "Two ways to go on",
  cast: "Cast this ballot",
  castExplained: "Sends the sealed ballot to the public board.",
  challenge: "Check the encryption first",
  challengeExplained:
    "Opens this sealed ballot so your other device can show it holds exactly what you chose. An opened ballot can never be counted, so you then answer again and seal a fresh one.",
  challengeOptional:
    "Optional. Checking now and then, by anyone, is what catches a device that changes votes.",
  // A challenged ballot, opened (sealed.tsx).
  openingTitle: "Opening your sealed ballot",
  opening: "This device is opening the sealed ballot. Nothing is sent.",
  openedTitle: "Your sealed ballot is opened",
  opened:
    "This device has opened the sealed ballot it showed you. It can't be counted now, and nothing was sent.",
  openedCode: "The tracking code it opened",
  checkElsewhereTitle: "Check it on your other device",
  checkElsewhere:
    "This screen was drawn by the device that sealed the ballot, so it can't vouch for itself. Save the opening and open it on the device that scanned the code: that device compares the two and shows what the ballot holds.",
  saveOpening: "Save the opening",
  savedOpeningNote:
    "Save it before you answer again: once you leave this screen it can't be saved. The opening shows how you answered this time, so keep it to yourself and delete it once you have checked it.",
  answerAgainExplained:
    "Your answers aren't kept: you answer again, and this device seals them anew.",
  // When sealing or opening stopped (sealed.tsx).
  cantSealTitle: "This ballot can't seal answers for this poll yet",
  cantSealVersion:
    "This poll is of an older kind that this version of the ballot doesn't seal. Nothing was sealed or sent.",
  noIdentityTitle: "This device has no voting identity yet",
  noIdentity:
    "Answering this poll needs a voting identity kept on this device, and this copy of the ballot can't make and register one for it. Nothing was sealed or sent.",
  identityUnreadableTitle: "The voting identity on this device can't be read",
  identityUnreadable:
    "This browser didn't let the ballot read it, or what it keeps isn't a voting identity. Nothing was sealed or sent. Don't clear this site's data: your identity may still be there.",
  unregisteredTitle: "Your voting identity isn't registered yet",
  unregistered:
    "This device keeps a voting identity that isn't on any list yet, and this copy of the ballot can't register it. Nothing was sealed or sent. Don't clear this site's data: the identity is still yours.",
  recoveredCastTitle: "This device can't answer with a recovered identity yet",
  recoveredCast:
    "Your voting identity came back to this device from its backup. Before it answers a poll, this device must show you any ballot you cast from another device, and this version of the ballot can't yet. Nothing was sealed or sent. Answer from the device you voted on before, or wait for a later version.",
  notListedTitle: "You aren't on this poll's list",
  notListed:
    "This poll is open to people verified in other ways than your voting identity was, so you can't answer it. Nothing was sealed or sent.",
  boardUnavailableTitle: "The poll's public board couldn't be read",
  boardUnavailable:
    "This device reads the whole board to find your place on the poll's list, and it couldn't this time. Check your connection and answer again. Nothing was sealed or sent.",
  noRegistrarsTitle: "This copy of the ballot can't find you on a poll's list yet",
  noRegistrars:
    "It doesn't yet know whose signatures add people to the lists, so it can't rebuild one. Nothing was sealed or sent.",
  cellRefusedTitle: "Your place on the poll's list couldn't be found",
  cellRefused:
    "The board this device read doesn't show you among this poll's members, or doesn't check. A server may have sent an incomplete board, or your registration may not be on it yet. Answer again later. Nothing was sealed or sent.",
  sealFailedTitle: "This device couldn't seal your answers",
  sealFailed:
    "Nothing was sent. Answer again, or open the ballot from abolishus.eth or another address Abolish lists.",
  openFailedTitle: "This device couldn't open the sealed ballot",
  openFailed:
    "The ballot it sealed can't be counted now, and nothing was sent. This copy of the ballot may be faulty: open it from abolishus.eth or another address Abolish lists.",
  noL1Title: "This ballot can't read Ethereum yet",
  noL1: "Each cast ballot names a recent Ethereum block that this device reads for itself, and this version of the ballot can't read one yet. Your ballot wasn't made and nothing was sent.",
  castFailedTitle: "This device couldn't make your ballot",
  castFailed:
    "Nothing was sent. Answer again, or open the ballot from abolishus.eth or another address Abolish lists.",
  castFaultyTitle: "Your ballot didn't pass this device's check",
  castFaulty:
    "This device checks every ballot before it is sent, and this one was wrong, so it wasn't sent. This copy of the ballot may be faulty: open it from abolishus.eth or another address Abolish lists.",
  noDeliveryTitle: "This ballot can't send your ballot yet",
  noDelivery:
    "A cast ballot counts only once its parts reach the poll's trustees, and this version of the ballot can't deliver them every way it must yet. Your ballot wasn't made and nothing was sent.",
  castsUnreadableTitle: "This device's record of your ballots can't be read",
  castsUnreadable:
    "This device keeps a record of every ballot it sends, so a new one never cancels an earlier one, and that record can't be read now. Nothing was sent. Check that this browser keeps site data, then answer again.",
  castsUnwritableTitle: "This device couldn't record your ballot",
  castsUnwritable:
    "A ballot is sent only once this device has recorded it, so a new one never cancels it, and this browser refused the record. Nothing was sent. Check that this browser keeps site data, then answer again.",
  notNewerTitle: "Wait a moment, then answer again",
  notNewer:
    "Your last ballot from this device is so recent that a new one now would cancel it instead of replacing it. Nothing was sent. Answer again in a minute.",
  // Delivering and sending a cast ballot (sealed.tsx).
  resumingTitle: "Opening your ballot",
  resuming: "This device is checking its record of the ballots it cast in this poll.",
  unsentEarlierTitle: "Your last ballot here wasn't sent",
  unsentEarlier:
    "This device sealed and recorded a ballot for this poll, but the board never confirmed it. Send it to finish casting it, or answer again: a new ballot replaces it.",
  deliveringTitle: "Handing your ballot to the poll's trustees",
  delivering:
    "This device recorded your sealed ballot and is giving each of the poll's trustees its sealed part. Keep this page open.",
  unsentUndeliveredTitle: "Your ballot hasn't reached every trustee yet",
  unsentUndelivered:
    "A ballot counts only once each of the poll's trustees has its sealed part, and some didn't take theirs this time. This device sent nothing to the board, but whoever passed the parts on could still put this ballot there, where it would replace your earlier one without counting. Send it again in a minute; if it still doesn't go through, answer again while the poll is open.",
  sendingTitle: "Sending your ballot",
  sending:
    "This device recorded your sealed ballot and is sending it to the public board. Keep this page open.",
  sendAgain: "Send again",
  sendAgainTitle: "Sending again is safe",
  sendAgainExplained:
    "It sends the same sealed ballot this device recorded, never a new one, so it can't count twice or cancel itself.",
  unsentBusyTitle: "The board is busy",
  unsentBusy: "Your ballot wasn't taken yet. Wait a minute, then send it again.",
  unsentUnavailableTitle: "Your ballot may not be on the board yet",
  unsentUnavailable:
    "The board didn't answer in time, so this device can't tell whether it took your ballot. Send it again to find out.",
  unsentUnreachableTitle: "Your ballot couldn't be sent",
  unsentUnreachable:
    "The board couldn't be reached, or its answer wasn't one this device reads. Check your connection, then send it again.",
  unsentUnconfirmedTitle: "The board's answer doesn't show your ballot",
  unsentUnconfirmed:
    "It answered with something other than your ballot, so this device can't tell whether it took it. Send it again, or later open the ballot from abolishus.eth or another address Abolish lists.",
  // The posting offer for a ballot some trustees didn't take (posting-offer.tsx).
  checkingPostingTitle: "Checking what this device kept",
  checkingPosting:
    "Before offering you a choice, this device is checking that the parts it kept for these trustees are the ones your ballot sealed.",
  postingOfferTitle: "Some trustees haven't taken your ballot",
  postingOffer: {
    one: "Your ballot counts only once each of the poll's trustees has its sealed part, and one didn't take theirs. This device sent nothing to the board. Choose what to do.",
    other:
      "Your ballot counts only once each of the poll's trustees has its sealed part, and {count} didn't take theirs. This device sent nothing to the board. Choose what to do.",
  },
  postingRetry: "Try the trustees again",
  postingRetryTitle: "Try again",
  postingRetryExplained:
    "This device hands the same sealed parts to the trustees again, so nothing counts twice. Wait a minute first.",
  postingPostTitle: "Post the missing parts publicly",
  postingPostExplained:
    "The missing parts go on the public record with the key to their outer seal, so the trustees can open them without having taken them. Your vote stays secret today, but those parts lose their long-term protection: anyone who later breaks today's encryption can read them, and if enough of your ballot's parts are posted to open it, they can read your whole ballot. This can't be undone.",
  postingPost: "Post publicly, then send",
  postingDeclineTitle: "Leave this ballot",
  postingDeclineExplained:
    "This device erases the parts it kept for these trustees, and this ballot won't count. Whoever passed the parts on could still put it on the board, where it would replace your earlier ballot without counting, so answer again while the poll is open.",
  postingDecline: "Leave this ballot",
  postingFailedTitle: "The posting didn't go through",
  postingFailed:
    "Nothing was posted or sent to the board. Try posting again in a minute, or choose another way.",
  postingRelayedTitle: "The posting isn't on the board yet",
  postingRelayed:
    "Our posting relay, run by the poll's operator, was given the missing parts with the key to their outer seal, so count them as posted: they may still reach the public record, and leaving this ballot can't take them back. Try posting again in a minute: the same parts go again, never new ones.",
  postingWalletOfferTitle: "Post from your own wallet",
  postingWalletOffer:
    "Our relay didn't put the missing parts on the public record, so your own Ethereum wallet can, paying the network's fee. The address that pays is published for good beside this ballot and every new answer you give in this poll, so use a fresh address funded privately, never one tied to you or to an exchange account. Your wallet and the node it uses see the missing parts before the public record does. If the network doesn't take the posting within ten minutes, or your wallet's node refuses it, your wallet asks you to force it through Ethereum from the same address, which needs ETH there too and costs more. This device sends your ballot only once the record shows them.",
  postingWalletPost: "Post from my wallet, then send",
  postingHandedTitle: "The missing parts may still reach the board",
  postingHanded:
    "This try or an earlier one gave the missing parts to our posting relay or to your wallet, so count them as posted: they may still reach the public record, and leaving this ballot can't take them back.",
  walletSentTitle: "Your wallet's posting isn't on the board yet",
  walletSent:
    "Your wallet sent the missing parts, or may still send them, so count them as posted: they may still reach the public record, and leaving this ballot can't take them back. Decline any request still open in your wallet, wait a few minutes, then post from your wallet again: this device looks for them first, and asks your wallet only for what isn't there.",
  walletForcedTitle: "Your wallet forced the posting through Ethereum",
  walletForced:
    "The network didn't take your wallet's posting in time, or your wallet's node refused it, so your wallet sent it through Ethereum, which the network has to include. Count the missing parts as posted: they reach the public record by the poll's delivery deadline, which can take some hours, and leaving this ballot can't take them back. Keep this page open, and don't reload it or open this ballot in another tab: after the poll's posting cutoff that erases what this device kept for them, and your ballot can then no longer be sent from here. Post from your wallet again only once the record may show them: this device looks for them first, and sends your ballot once it finds them.",
  walletRejectedTitle: "Your wallet didn't send anything",
  walletRejected:
    "A request was declined in your wallet, so nothing more was sent from it. If your wallet had already shown you the posting, it and its node have seen the missing parts, and so may the node this device reads the board through. Choose again below.",
  walletRefusedTitle: "Your wallet refused this posting",
  walletRefused:
    "Your wallet's check of the posting says the board would refuse it, and it couldn't be forced through Ethereum instead, so nothing was sent and none of your fee was spent. Your wallet and its nodes, and the node this device reads the board through, may have been given the missing parts for those checks. Try the trustees again, or leave this ballot.",
  walletWrongChainTitle: "Your wallet is on another network",
  walletWrongChain:
    "Your wallet didn't switch to the network the poll's board is on, so nothing was sent this time. Switch it there, then post from your wallet again.",
  walletMissingTitle: "No wallet in this browser",
  walletMissing:
    "This device found no Ethereum wallet to ask. Add one to this browser, or open the ballot in a browser that has one, then post from your wallet again.",
  walletLateTitle: "The time for posting has passed",
  walletLate:
    "The poll's posting cutoff has passed, so nothing was sent from your wallet this time and nothing more can be posted for this ballot.",
  walletFailedTitle: "Your wallet didn't answer",
  walletFailed:
    "Your wallet or its node didn't answer in time, or answered with an error. It may have been given the missing parts, so count them as given. Decline any request still open in your wallet, then try again in a minute.",
  declinedTitle: "This ballot won't count",
  declined:
    "This device erased the parts it kept for the trustees that didn't take theirs. Answer again while the poll is open: your new ballot replaces this one, and your earlier one, wherever they reach the board.",
  decliningTitle: "Leaving this ballot",
  declining: "This device is erasing the parts it kept for this ballot.",
  postingTitle: "Posting the missing parts",
  posting:
    "This device is posting the missing parts publicly, then sending your ballot. Keep this page open.",
  postingWalletTitle: "Posting from your wallet",
  postingWallet:
    "Confirm each request in your wallet, on Ethereum too if it asks to force the posting through. This device then waits for the board to record the missing parts before it sends your ballot. Keep this page open.",
  sentTitle: "Your ballot is on the board",
  sent: "The public board took your sealed ballot, and this device checked that the board's answer carries exactly the ballot it sent.",
  sentCopy: "The public board already holds a copy of your sealed ballot, which stands for yours.",
  sentIndex: "Entry {index} on the board",
  sentUnsignedTitle: "What this device checked",
  sentUnsigned:
    "The board's answer isn't signed yet, so it is the board's word. Later, check on the board from another device that your tracking code is there.",
  revoteExplained:
    "You can change your answers until the poll closes. A new ballot from this device replaces this one.",
  sendRejectedTitle: "The board refused your ballot",
  sendRejected:
    "It named the check your ballot failed. This copy of the ballot may be faulty: open the ballot from abolishus.eth or another address Abolish lists.",
  sendRefusedTitle: "The board couldn't take your ballot",
  sendRefused:
    "It doesn't know this poll, or couldn't read the request. Nothing was counted. Open the ballot from abolishus.eth or another address Abolish lists.",
  notOpenTitle: "This poll isn't taking ballots",
  notOpen: "By the board's clock the poll hasn't opened yet or has closed, so nothing was counted.",
  answerConflictTitle: "The board gave two answers for one ballot",
  answerConflict:
    "This device recorded where the board put your ballot, and the board now says somewhere else. Report it, with your tracking code, to whoever runs the poll.",
  // Proving membership (proving.tsx); each refusal names the check that stopped it.
  provingTitle: "Proving you can answer",
  proving:
    "This device is making a proof that you are one of this poll's members, without showing which one. Keep this page open.",
  provingLabel: "Your proof",
  provingStarting: "Starting",
  provingSteps: "{done} of {of} steps",
  provingLocalTitle: "Made on this device",
  provingLocal:
    "Your voting identity never leaves it. The proof says only that you are on the poll's list, and this device checks it before anything is sent.",
  proofCheckTitle: "The check that stopped it",
  proofCheckNamed: "Its name, for whoever you report this to:",
  proofNothingSent: "No proof and no answer left this device, and nothing was counted.",
  proofSecretTitle: "Your voting identity on this device can't be used",
  proofSecret:
    "The identity this device keeps for voting isn't a valid one, so no proof can be made from it.",
  proofNotMemberTitle: "You aren't on this poll's list",
  proofNotMember:
    "Your voting identity isn't among the members this poll was opened to, so this device can't prove you may answer it. If you think you should be, tell whoever asked you to answer.",
  proofRootTitle: "The list of members doesn't match the poll",
  proofRoot:
    "The members this device was sent don't add up to the list registered for this poll, so a server may have sent a wrong or incomplete list. Try again later.",
  proofUnavailableTitle: "The files for making proofs couldn't be fetched",
  proofUnavailable:
    "This copy of the ballot didn't serve them. Check your connection and try again, or open the ballot from another address.",
  proofZkeyTitle: "The proving key isn't the published one",
  proofZkey:
    "The key this device was served for making proofs isn't the one this version of the ballot pins, so it wasn't used. Open the ballot from abolishus.eth or another address Abolish lists.",
  proofWasmTitle: "The proof's calculator isn't the published one",
  proofWasm:
    "The file this device was served for working out the proof isn't the one this version of the ballot pins, so it wasn't used. Open the ballot from abolishus.eth or another address Abolish lists.",
  proofProverTitle: "The part that makes proofs didn't answer properly",
  proofProver:
    "It stopped, answered out of turn or took too long. This copy of the ballot may be faulty: open it from abolishus.eth or another address Abolish lists.",
  proofStoppedTitle: "This device stopped while making the proof",
  proofStopped:
    "The proof didn't finish. Open the ballot from abolishus.eth or another address Abolish lists.",
  proofWrongTitle: "The proof didn't pass this device's check",
  proofWrong:
    "This device checks every proof before it is sent, and this one was wrong. This copy of the ballot may be faulty: open it from abolishus.eth or another address Abolish lists.",
  proofFaultTitle: "This device made a fault while finishing the proof",
  proofFault:
    "The finished proof didn't pass this device's own check, so it wasn't sent. This copy of the ballot may be faulty: open it from abolishus.eth or another address Abolish lists.",
  // Registering at Tier 0 (register.tsx).
  makeIdentityTitle: "Make a voting identity on this device",
  makeIdentity:
    "To answer this poll, this device makes a voting identity and asks for it to be added to the list of people who registered here.",
  makeIdentityStart: "Make my voting identity",
  registerTitle: "Register your voting identity",
  register:
    "This device keeps a voting identity that isn't on any list yet. To answer this poll, ask for it to be added to the list of people who registered here.",
  registerStart: "Register it",
  identityKeptTitle: "It stays on this device",
  identityKept:
    "Your voting identity is a secret number made and kept here, never sent anywhere. Only a code worked out from it goes on the list, and your answers can't be linked back to it.",
  registerStepsTitle: "What happens next",
  registerSteps:
    "You show you're a person on a check page run by Cloudflare, then this device sends the code. It's added to the list in a batch with others within an hour or so, and you come back to answer.",
  registerPreparingTitle: "Making your voting identity",
  registerPreparing: "This device is making your voting identity and keeping it. Nothing is sent.",
  registerSendingTitle: "Sending your registration",
  registerSending: "This device is sending the code worked out from your voting identity.",
  challengeStepTitle: "Show you're a person",
  challengeStep:
    "Solve the check below. Once it passes, this device sends your registration straight away.",
  challengeSeesTitle: "What the check page sees",
  challengeSees:
    "It runs on a site of its own and hands this device only a pass. It never sees your voting identity, its code or your answers.",
  registerSentTitle: "Your registration was sent",
  registerSent:
    "The code from your voting identity is waiting to be added to the list. Your identity stays on this device.",
  registerWaitTitle: "Come back in an hour or so",
  registerWait:
    "Registrations are added in batches, and a batch can wait for others to join it, so yours may take an hour or more to appear. Don't clear this site's data meanwhile: your identity is kept only here.",
  backToPoll: "Back to the poll",
  registerWaitingTitle: "Your registration is on its way",
  registerWaiting:
    "This device sent your registration on {when}. Once it is on the list you can answer this poll.",
  checkAgain: "Check again",
  registerUnwritableTitle: "This browser won't keep a voting identity",
  registerUnwritable:
    "It refused to store one, perhaps in a private window or with site data blocked. Nothing was sent. Open the ballot in a normal window to register.",
  registerWorkerFailedTitle: "This device couldn't prepare your registration",
  registerWorkerFailed:
    "Nothing was sent. Your voting identity, if one was made, is kept on this device. Try again.",
  challengeRefusedTitle: "The check didn't pass",
  challengeRefused:
    "The registration wasn't accepted because the check's pass was refused or ran out. Nothing changed. Try the check again.",
  registerLaterTitle: "Your registration couldn't be sent",
  registerLater:
    "The registration service was busy, unavailable or unreachable. Your voting identity is kept on this device. Try again in a few minutes.",
  registerFaultyTitle: "The registration service refused this request",
  registerFaulty:
    "It says the request isn't one it takes, so this copy of the ballot may be faulty. Your voting identity is kept on this device. Open the ballot from abolishus.eth or another address Abolish lists.",
  registerNotNotedTitle: "Your registration was sent, but this device couldn't note it",
  registerNotNoted:
    "The voting identity on this device changed or couldn't be read back, so it may be offered for registration again. Don't clear this site's data.",
  registerReadingTitle: "Checking your registration",
  registerReading:
    "This device is reading the public list of registrations, all of it, so nobody learns which entry it looks for.",
  registerDueTitle: "Your registration hasn't appeared yet",
  registerDue:
    "This device sent your registration on {when}, and it should be on the list by now. It may have been dropped, so you can send it again.",
  registerRepeatTitle: "Sending it again is safe",
  registerRepeat:
    "It's the same code from the same voting identity, for the same area. If the first one is added after all, the second changes nothing.",
  registerAgain: "Send it again",
  registerJoinedTitle: "You're registered",
  registerJoined:
    "The code from your voting identity is on the list, and this device has noted it. You can answer this poll now.",
  registerMovedTitle: "Your voting identity was put on another area's list",
  registerMoved:
    "The code from your voting identity is on the public list, but for a different area than the one this device asked for, so your answers would be counted there. Don't answer polls with it, and don't clear this site's data.",
  registerMovedWhyTitle: "Why this matters",
  registerMovedWhy:
    "Someone else added your code there before your own registration landed. That can't be undone: only a new voting identity would put you back in your own area. This device offers a new one only once a second, separate source of the list shows the same, since one source could be wrong, and only once your own registration has had time to land, since it would still count first. Check again in a while.",
  registerMovedConfirmed:
    "Two separate sources of the public list agree: the code from your voting identity is on it for a different area than the one this device asked for, so your answers would be counted there. Don't answer polls with it.",
  registerMovedStartAgain:
    "That can't be undone, so this device can make you a new voting identity in place of this one, which you then register for your own area. The old one is discarded from this device. A backup you made of it still holds the old one until you back up the new one.",
  registerStartAgain: "Make a new voting identity",
  registerReplacingTitle: "Making your new voting identity",
  registerReplacing:
    "This device is reading the list again from both sources and checking that it still holds the identity that was moved, then making a new one in its place. Nothing is sent.",
  outcomeDisputedTitle: "Two sources of the list disagree",
  outcomeDisputed:
    "One source showed your code on another area's list, and a second, separate source didn't show the same. One of them is wrong, so this device changed nothing, and your voting identity is kept. Try again in a few minutes.",
  notReplacedTitle: "Your voting identity was kept",
  notReplaced:
    "The voting identity on this device isn't the one that was moved any more, or it's registered in a group, so it wasn't replaced. Nothing was sent. Try again to check this poll anew.",
  registryUnavailableTitle: "Your registration couldn't be checked",
  registryUnavailable:
    "The public list of registrations couldn't be read in full, or what came back wasn't it. Nothing was sent, and your voting identity is kept on this device. Try again in a few minutes.",
  noGroupRegistryTitle: "This copy of the ballot can't check registrations",
  noGroupRegistry:
    "It doesn't know where the public list of registrations is kept. Your registration was sent and your voting identity is kept on this device. Open the ballot from abolishus.eth or another address Abolish lists.",
  regionChangedTitle: "This copy of the ballot serves a different area",
  regionChanged:
    "Your registration asked for an area this copy of the ballot no longer registers people in, so it won't check or resend it here. Your voting identity is kept on this device. Open the ballot from abolishus.eth or another address Abolish lists.",
  joinNotNotedTitle: "You're registered, but this device couldn't note it",
  joinNotNoted:
    "The voting identity on this device changed or couldn't be written. Nothing was sent. Try again: the list is read afresh.",
  // Backing up the voting identity with a passkey (backup-offer.tsx).
  backupOfferTitle: "Back up with a passkey?",
  backupOffer:
    "So your voting identity isn't lost with this device: a sealed copy is stored that only your passkey opens.",
  backupStart: "Back up with a passkey",
  backupSkip: "Not now",
  backupSkipMeans:
    "If you skip it, you can still answer on this device. A new device would start as someone new. Your receipts stay on this device either way.",
  backupSectionTitle: "Passkey backup",
  backupSkipped: "No backup for now. You can keep answering on this device.",
  backupWorking:
    "Follow your browser's passkey prompt. This device seals your voting identity under the passkey, then stores the sealed copy.",
  backupStoredTitle: "Backed up with your passkey",
  backupStored:
    "A sealed copy of your voting identity is stored, and only your passkey opens it. Your receipts stay on this device.",
  backupNoSyncTitle: "This passkey can't be copied to your other devices",
  backupNoSync:
    "The backup is stored, but the passkey that opens it lives only on this device or security key, so it's lost with it. Don't clear this site's data.",
  backupNotSyncedTitle: "Your passkey isn't on your other devices yet",
  backupNotSynced:
    "The backup is stored, but until your passkey app copies the passkey, losing this device would lose it too. Check again once your devices have synced.",
  backupCheckSync: "Check again",
  backupRetry: "Try again",
  backupUnreadableTitle: "There's no voting identity to back up",
  backupUnreadable:
    "This device couldn't read a voting identity or its backup record, so nothing was backed up. Don't clear this site's data.",
  backupUnwritableTitle: "This browser won't keep the backup's record",
  backupUnwritable:
    "It refused to store which passkey holds the backup, perhaps in a private window or with site data blocked, so nothing was backed up. Open the ballot in a normal window to back up.",
  backupCancelledTitle: "The passkey prompt was closed",
  backupCancelled: "Nothing was backed up. Try again when you're ready.",
  backupUnsupportedTitle: "This passkey can't hold a backup",
  backupUnsupported:
    "Your browser or passkey app doesn't support what the backup needs, so nothing was saved. You can keep answering on this device. To back up, try another browser or passkey app.",
  backupNoUvTitle: "The passkey didn't check it was you",
  backupNoUv:
    "A backup needs your passkey to ask for your fingerprint, face, PIN or screen lock, and this one didn't, so nothing was saved. Try again, or use another passkey app.",
  backupFailedTitle: "The backup didn't finish",
  backupFailed: "Something on this device stopped it, and nothing was backed up. Try again.",
  backupRejectedTitle: "The backup service refused this backup",
  backupRejected:
    "It says the sealed copy isn't one it takes, so this copy of the ballot may be faulty. Open the ballot from abolishus.eth or another address Abolish lists.",
  backupUnreachableTitle: "The backup couldn't be stored",
  backupUnreachable:
    "The backup service was unavailable or unreachable. Your voting identity is still on this device. Try again in a few minutes.",
  backupNotKeptTitle: "The backup service didn't keep the backup",
  backupNotKept:
    "It accepted the sealed copy but didn't give it back when this device checked, so it isn't counted as backed up. Try again.",
  // Recovering the voting identity on a new device (recover.tsx).
  recoverOfferTitle: "Made one on another device?",
  recoverOffer:
    "If you backed up your voting identity with a passkey, bring it back here instead of making a new one.",
  recoverOfferStart: "Recover it with a passkey",
  recoverTitle: "Recover your voting identity",
  recover:
    "Your browser asks for the passkey you backed up with. This device fetches the sealed copy, opens it with the passkey and checks your identity is on a public list before keeping it.",
  recoverStart: "Use my passkey",
  recoverKeptTitle: "It's opened only on this device",
  recoverKept:
    "Your voting identity comes back sealed and is opened here, never anywhere else. The backup service sees only a code from your passkey, and the public list is read in full, so no server learns which identity is yours.",
  recoverLeftTitle: "What doesn't come back",
  recoverLeft:
    "Receipts and the record of how you answered stay on the device you used before. A device that already has a voting identity can't recover another.",
  recoverWorkingTitle: "Recovering your voting identity",
  recoverWorking:
    "Follow your browser's passkey prompt. This device then fetches the sealed copy, opens it and checks the public list. Nothing about your identity or your answers is sent.",
  recoveredTitle: "Your voting identity is on this device",
  recovered:
    "It opened, and the public list counts it in area {region}. This device keeps it from now on.",
  recoveredAreaTitle: "Check the area",
  recoveredArea:
    "If area {region} isn't where you registered, someone may have moved your identity before you recovered it. Don't answer polls with it, and don't clear this site's data.",
  recoveredOneDeviceTitle: "Answer each poll from one device",
  recoveredOneDevice:
    "Your passkey can bring this identity to more than one device. Two devices that answer the same poll without each other's records can cancel your vote, so use just one per poll.",
  recoveredNoSync:
    "Your identity is back, but the passkey that opens its backup lives only on this device or security key, so the backup is lost with it.",
  recoveredNotSynced:
    "Your identity is back, but until your passkey app copies the passkey, losing this device would lose the backup too.",
  recoverOther: "Try another passkey",
  recoverUnreadable:
    "This browser didn't let the ballot read what it keeps, so nothing was recovered over it. Don't clear this site's data: your identity may still be there.",
  recoverCancelledTitle: "The passkey prompt was closed",
  recoverCancelled: "Nothing was recovered. Try again when you're ready.",
  recoverUnsupportedTitle: "This passkey can't open a backup",
  recoverUnsupported:
    "Your browser or passkey app doesn't support what the backup needs. Try the passkey from another passkey app, or another browser.",
  recoverNoUv:
    "Opening a backup needs your passkey to ask for your fingerprint, face, PIN or screen lock, and this one didn't, so nothing was recovered. Try again.",
  recoverFailedTitle: "The recovery didn't finish",
  recoverFailed: "Something on this device stopped it, and nothing was recovered. Try again.",
  recoverUnreachableTitle: "The backup couldn't be fetched",
  recoverUnreachable:
    "The backup service was unavailable or unreachable, and nothing was recovered. Try again in a few minutes.",
  recoverNoBackupTitle: "There's no backup for this passkey",
  recoverNoBackup:
    "The backup service holds nothing for the passkey you chose. If you have another passkey for this ballot, try that one.",
  recoverDamagedTitle: "This backup can't be opened",
  recoverDamaged:
    "What the backup service gave back doesn't open with this passkey, so nothing was recovered. If you have another passkey for this ballot, try that one.",
  recoverRegistryTitle: "Your identity couldn't be checked",
  recoverRegistry:
    "The public list of registrations couldn't be read in full, or what came back wasn't it, so nothing was kept. Try again in a few minutes.",
  recoverNoGroupRegistryTitle: "This copy of the ballot can't check registrations",
  recoverNoGroupRegistry:
    "It doesn't know where the public list of registrations is kept, so it can't recover an identity. Open the ballot from abolishus.eth or another address Abolish lists.",
  recoverNotRegisteredTitle: "Your identity isn't on a list yet",
  recoverNotRegistered:
    "The backup opened, but no list this ballot reads counts its identity, so nothing was kept. A registration sent in the last few hours may not be added yet: try again later.",
  recoverUnwritableTitle: "This browser won't keep a voting identity",
  recoverUnwritable:
    "It refused to store one, perhaps in a private window or with site data blocked, so nothing was recovered. Open the ballot in a normal window to recover.",
} as const;

export type Messages = Record<keyof typeof enUS, Message>;

// Both catalogs are in the entry's script: the client's page may import no
// chunk of its own (tests/bundle.test.ts), and Spanish adds about 12 KiB
// gzipped.
export const catalogs: Readonly<Record<Locale, Messages>> = { "en-US": enUS, "es-US": esUS };

/** Each language named in itself, for the frame's switch. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  "en-US": "English",
  "es-US": "Español",
};
