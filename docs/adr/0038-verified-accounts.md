# ADR 0038: Verified accounts: email and phone

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-22
- Deciders: agent, owner may veto (rule A). Signing up for and paying the SMS and email providers, and the privacy notice and processor terms that come with them, are the owner's (spending, legal).
- Threats addressed: T-01, T-10, T-11, T-52, T-65, T-69, T-73 (see [[THREAT_MODEL]])

## Context

The owner decided on 2026-10-21 that every account is verified by email and by phone, one account per phone number, with the number "kept only as a keyed hash for that check, never in the clear" ([[PROJECT_BRIEF]], Identity; [[0024-tier0-registration]], Owner decision). With [[P2-30]], an account takes at most one Tier 0 token per group, so the number is what a second Tier 0 identity in a group costs. Accounts today are passkey-only, and their tables refuse any e-mail address by check constraint ([[P2-5]]). [[P2-31]] builds the verification; this ADR fixes what it is built on:

1. who sends and checks the codes, and who says a number is virtual;
2. how the number's keyed hash is made, and how its key is rotated when the number itself is gone;
3. how email is kept, since notifications ([[P2-27]]) must send to it;
4. what happens to a number when an account leaves it, so it can't be cycled through accounts;
5. which countries' numbers are taken at launch;
6. what the new parties learn (T-73).

What is one-way: once a number is reduced to a keyed hash, the number can't be recovered, so any later change to the hash (its input form, its key) must be computable from the stored value alone, or every account must verify again. And each provider keeps what it was sent under its own retention; choosing it decides who holds that record.

## Options

### Phone codes and the line-type check

**A. A managed verification service: Twilio Verify, with Twilio Lookup's line-type data** (recommended in [[P2-31]]). Verify makes, sends and checks the code (SMS, or a voice call for a landline), with its own per-number send limits and fraud screening for SMS pumping; we hold no code. Lookup's line-type intelligence classifies a number (mobile, landline, fixed or non-fixed VoIP, toll-free and others) before any code is sent.

- Pros: no code store of ours, and the provider's fraud screening and country permissions bound toll fraud (T-52). One provider for both steps, so one more party (T-73), not two.
- Cons: the provider sees each number, when it was checked, its line type and whether the code was right, and keeps that under its retention. Lock-in is shallow: the adapter is two calls.

**B. Our own codes over a plain SMS API** (Twilio Messaging, Vonage, AWS SNS), with a separate line-type lookup.

- Pros: the code never leaves us except in the message.
- Cons: we store and rate-limit codes, and carry pumping fraud ourselves; the SMS provider still sees every number and its time, so the privacy is the same as A's. Two parties if the lookup is another vendor.

**C. No phone, a stronger email check** (disposable-domain lists, provider reputation). Rejected: the owner chose phone as the lever, and addresses cost nothing.

### The number's keyed hash

The number is normalised to E.164 first (country code, no spaces or punctuation), so one line has one hash.

**A. HMAC-SHA-256 under a server key, rotated by nesting** (chosen). The stored value is `h = HMAC(k_n, … HMAC(k_2, HMAC(k_1, "abolish/phone/v1" ‖ number)))`, with the key IDs it was made under. Rotating to a new key `k_{n+1}` rewrites every stored `h` as `HMAC(k_{n+1}, h)` in one migration job, and lookups compute the chain over every key in order. The number is never needed to rotate.

- Pros: a dump of the database alone reveals nothing, and a leaked key stops mattering once the next rotation has run, since an attacker needs every key in the chain together with the table. The value stays 32 bytes, however many rotations.
- Cons: every key is kept for good (each is useless without the later ones). The number space is small (about 10^10 numbers per country code), so whoever holds the table and every key enumerates every number in minutes: the hash's protection is the keys' secrecy, nothing more, and that is stated plainly in T-73.

**B. HMAC with replacement on re-verification.** A new key is used for new hashes, old ones are checked under the old key until each account verifies again. Rejected: the old key stays live until every account has re-verified, which some never do, so a leaked key can't be retired.

**C. The key in a managed KMS or HSM** (an HMAC key in AWS KMS or Google Cloud KMS). The key never sits in our process, so a dump of the process's memory or environment doesn't yield it. Rejected for launch: a third cloud provider and a running cost, and a compromised server still asks the KMS for any hash it likes, which is all an enumeration needs. A can move to C later, since nesting lets a KMS-held key be the next one.

### Email

**A. In the clear, unique on the lowercased address.** Simple; a dump of the database is a list of who uses Abolish.

**B. Encrypted at rest, unique on a keyed hash** (chosen). The address is kept as AES-256-GCM ciphertext under an encryption key, and as an HMAC of the lowercased address under an email-hash key for the one-account-per-address check, from the same keyring as the phone's (separate keys and labels per use). The account side decrypts it only to send a message or show the account its own address. Rotation re-encrypts and re-hashes every row, since the address can be decrypted.

- Pros: a database dump or backup alone (T-66, T-69) yields no addresses and no numbers.
- Cons: the server can always decrypt, so a running compromise of the account side gets every address; it protects data at rest, not a live server.

Uniqueness folds case only (the whole address lowercased after Unicode NFC), never provider tricks such as Gmail's dots and `+tags`: the phone, not the address, is the Sybil cost, and folding guesses wrong for other providers.

Email is verified by a code, not a link: 8 digits, single use, 15 minutes, 5 tries, stored only as a hash bound to the account, entered on the page that asked for it, so it works when the mail is read on another device and gives a phishing page no link to copy. The sending service is shared with [[P2-27]]. Its provider must be transactional-only, with open and link tracking off, so no message carries a tracking pixel or rewritten link (T-67): Postmark is recommended, Amazon SES the alternative; both sit behind one adapter, so the choice is the owner's sign-up and can change.

### A number an account leaves

**A. Freed at once.** Rejected: one number then verifies an account, the account takes its tokens, the number is moved on, and so on, a Tier 0 identity per group per move.

**B. Held for a cooling-off period** (chosen: 90 days). When an account deletes itself or changes its number, the number's hash goes to a holds table with the day it was freed and no account, for 90 days; no account can verify a held number until then. A number verified by another account while still held there is refused, with the reason in plain words.

A number can also be recycled by its carrier to a new person while an old account still holds it. Verifying a number another account holds **moves** it, if that account verified it more than 90 days ago and it hasn't moved since: the new account holds it, the old one loses its verified phone (it keeps its tokens already taken, and takes no new ones until it verifies another number), and the move starts a new 90 days. So the account side keeps, with each held number's hash, the day it was last verified or moved, and nothing finer. US carriers age a disconnected number for 45 to 90 days before reassigning it, so a recycled number is usually movable when its new owner arrives. A SIM swap can take a victim's number this way; it costs the victim their verified phone, never their account, whose sign-in is its passkeys.

So one number makes at most one account's Tier 0 tokens per 90 days.

**C. Never freed.** Rejected: a recycled number would lock its new owner out for good.

### Line types

Taken: `mobile` (SMS), and `landline` and `fixedVoip` (voice call). Refused, with the reason shown ("This looks like an internet or virtual number. Please use a mobile or home phone."): `nonFixedVoip`, `tollFree`, `premium`, `sharedCost`, `uan`, `voicemail`, `pager`, `personal` and an unknown type. A failed lookup refuses for now (503) rather than letting the number through.

### Countries at launch

**A. US and Canada** (chosen), matched on Lookup's country code, not on `+1`, which other countries share. The brief is US first; both are low-risk for SMS pumping and well served.

**B. Worldwide from the start.** Rejected for launch: SMS pumping concentrates on premium-rate and small-carrier destinations, and every country added is a cost exposure (T-52).

Widening the list is a configuration change per country in the [[railway]] runbook, made once the pumping controls (below) have been seen working, with no new ADR. Until then, anyone without a US or Canadian number can't verify an account, so can't vote at Tier 0 at all: a real cost to the everyday app outside North America, stated in the sign-up screen and [[P2-31]].

## Recommendation

Twilio Verify with Lookup's line types; the number as a nested HMAC chain; email encrypted with a keyed-hash uniqueness check; 90 days' cooling-off with moves for recycled numbers; US and Canada at launch.

What would change it: a provider that sees less (none found: whoever sends the SMS learns the number and its time); evidence that numbers are being cycled faster than 90 days allows (lengthen it); pumping losses at the spend ceiling (narrow the countries or add Verify's geo-permissions more tightly).

## Consequences

**Limits and costs** (T-52):

- Turnstile on sign-up (as today) and on every request that sends a code, under new actions `email-code` and `phone-code`.
- Code sends per account: 5 an hour and 10 a day for each channel; per number hash, 5 a day across all accounts; Verify's own per-number limits besides. Counters in Redis keyed by the account or by the number's hash, never both in one key.
- A global daily ceiling on phone sends, checked before any send, like poll creation's ([[0032-poll-creation-operations]]), so pumping spends at most the ceiling a day.
- The proxy's per-address limits on both routes (P2-11).

**Separation** (T-10, T-11): the verification tables (the account's email ciphertext and hash, its phone hash and key IDs, the holds) are account-side tables in `TABLE_CLASSES.account`, covered by the no-join tests; nothing on the ballot path reads them. Verification happens on the website before an account takes a Tier 0 token ([[P2-30]]), never when voting, so its time is the account's, not a ballot's. Nothing about polls, answers or ballots is ever sent to either provider.

**Keys** (T-65): three keyrings in `apps/web`'s environment, never in the database or a log: phone-hash, email-hash and email-encryption, each a list of 32-byte keys with IDs. The rotation job and its runbook come with part 3. A leak of the phone-hash keys and the table together reveals every verified number (T-73).

**What the providers learn** (T-73, new): Twilio learns each number, when it was checked and its line type; the email provider learns each address and when it was sent a code or a notification. Each keeps that under its own retention, and each can be compelled (T-69). Neither learns an account ID, a poll, an answer or a ballot.

**Sybil cost** (T-01): a Tier 0 identity per group now costs a phone number that passes the line-type check, about a prepaid SIM or a few cents to a dollar at SMS-activation markets, which sell one-time verifications on real mobile numbers; and a state that runs or compels a carrier (A-1) makes numbers at will. It raises the cost; it doesn't make Tier 0 one-person-one-vote. T-01 stays **Not mitigated**, and Tier 0 stays labelled so.

**The account tables** change: P2-5's check refusing any e-mail address is replaced by columns that hold only the ciphertext and hashes above, with checks that refuse anything looking like a cleartext address or number, so the no-PII checks keep their purpose.

**Parts of [[P2-31]]** that follow: 2, email verification and the sending adapter; 3, phone verification, the keyed hash, holds and moves, the line-type refusal and the keyrings' rotation job and runbook; 4, the screens; 5, the gate on [[P2-30]]'s tokens. Until the owner signs up for the providers, every part runs against a fake adapter in tests and the providers' test credentials on staging.

## Decision

Under rule A (`AGENTS.md`): the options chosen above, status `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. Signing up for Twilio and an email provider, their terms, and the privacy notice that names them are the owner's; nothing goes live with real numbers until they are done.

## Amendment (P2-31 part 2a, 2026-10-22)

Building the e-mail half settled four details the text above left open or stated differently; none changes a decision.

- **Per-account counts are Postgres rows**, in the account class, as poll submissions' are ([[0032-poll-creation-operations]]), rather than Redis counters: they recheck under the account's lock in the same transaction as the code they count. The rule above still holds: no count is keyed by an account and an address (or number) together.
- **A daily cap per address** (5 messages, whichever accounts asked), keyed by the address's hash alone, so accounts made in bulk can't flood a mailbox through us (T-52). Past it, the request is answered as usual and nothing is sent, so the cap is no oracle. Its rows are timed to the hour, while an account's sends are timed to the second, so a dump can't join the two on the instant of a send; it can still narrow an address to the accounts that asked for a code in that hour. The cap also lets accounts made in bulk spend an address's 5 messages and keep its owner from verifying it that day: the cost of not letting them flood the mailbox. A request for an address another account holds sends that address a notice instead of a code and answers the requester the same way (T-11).
- **Folding**: the local part lowercased after NFC, as above, and the domain in its ASCII form (UTS 46, which folds case too), so a domain written in Unicode and in punycode is one address.
- **Rolling out a new key** takes two deploys: the key listed but not current everywhere, then current (`packages/core`'s keyring text marks the current key with `*`). An instance that doesn't hold a key can't match values made under it, so making a key current before every instance holds it could let one address be verified by two accounts. Part 3's rotation runbook follows this order.

## Amendment (P2-31 part 3a, 2026-10-22)

Building the phone half in `packages/core` settled these details; none changes a decision.

- **No number is stored while a code waits, either.** The page sends the number again with the code, and the waiting row keeps only the number's hash, which the answer's number must match. Verify holds the code.
- **A held number is refused at the code, not at the request.** A request for a number another account holds, or one held after an account let it go, is sent a code all the same; `number-held` comes only once the right code is entered, so the route can't be used to learn which numbers have accounts (T-11). It costs a send per such request, within the per-number cap.
- **The lookup counts.** A request is counted against the account's limits and the daily ceiling under the account's lock, before the lookup, since the lookup costs too, and stays counted whatever the lookup or the send says. The per-number cap counts codes sent; past it nothing is sent and the request is answered as usual, as e-mail's per-address cap is.
- **The chain is matched on every prefix.** A lookup computes the number's chain over every key in the keyring, oldest first, and matches a stored value on any prefix, so a value made under an older key still matches while a new key is staged or current, and the rotation job only extends each stored chain. So no key is ever dropped from the phone-hash keyring.
- **One line, one chain.** A request is refused unless the lookup gives back the number in the same E.164 form it was hashed in, so a trunk prefix or another written form can't make a second chain for one line.
- **A number's daily cap can be spent by others.** As with e-mail's per-address cap, accounts made in bulk can spend a number's 5 daily codes and keep its owner from verifying it that day: the cost of not letting them flood a phone or the spend (T-52).
- **A deleted account's number is held by a trigger** on `account_phones`, so every deletion path, better-auth's included, holds it; a move sets a transaction-local flag the trigger skips, since a moved number is held by its new account.
