import type { Message } from "@abolishus/ui";

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
  unreachableTitle: "This device couldn't reach the servers",
  unreachable: "Check your connection and try again. Nothing was sent.",
  badAnswerTitle: "A server sent something that isn't a poll",
  badAnswer:
    "This device stopped before showing anything. Try again later, or open the ballot from another address.",
  workerFailedTitle: "This device couldn't check the poll",
  workerFailed: "The check stopped before it finished. Try again. Nothing was sent.",
  tryAgain: "Try again",
  notSentTitle: "Your answers weren't sent",
  notSent:
    "This version of the ballot can't seal or send answers yet, so nothing left this device and nothing was counted.",
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
  send: "Send my answers",
  challenge: "Check the encryption first",
  challengeExplained:
    "Checking the encryption first opens a sealed copy of your answers to show it holds exactly what you chose. That copy can never be counted, so you then send a fresh one.",
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
    "The key this device was served for making proofs isn't the one this version of the ballot pins, so it wasn't used. Try again, or open the ballot from another address.",
  proofWasmTitle: "The proof's calculator isn't the published one",
  proofWasm:
    "The file this device was served for working out the proof isn't the one this version of the ballot pins, so it wasn't used. Try again, or open the ballot from another address.",
  proofProverTitle: "The part that makes proofs didn't answer properly",
  proofProver: "It stopped, answered out of turn or took too long. Try again.",
  proofStoppedTitle: "This device stopped while making the proof",
  proofStopped: "The proof didn't finish. Try again.",
  proofWrongTitle: "The proof didn't pass this device's check",
  proofWrong:
    "This device checks every proof before it is sent, and this one was wrong. This copy of the ballot may be faulty: open it from abolishus.eth or another address Abolish lists.",
  proofFaultTitle: "This device made a fault while finishing the proof",
  proofFault:
    "The finished proof didn't pass this device's own check, so it wasn't sent. This copy of the ballot may be faulty: open it from abolishus.eth or another address Abolish lists.",
} as const;

export type Messages = Record<keyof typeof enUS, Message>;

export const catalogs: Readonly<Record<string, Messages>> = { "en-US": enUS };
