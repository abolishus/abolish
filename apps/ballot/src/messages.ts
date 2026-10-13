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
} as const;

export type Messages = Record<keyof typeof enUS, string>;

export const catalogs: Readonly<Record<string, Messages>> = { "en-US": enUS };
