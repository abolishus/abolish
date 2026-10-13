# First answer

How a person who has never used Abolish gets from a tap on the website to an answer on the board, in the everyday register ([[language#Two registers]]). The mockups are in Storybook: `Mockups/Journey/Handoff` (apps/web, `journey-*`) and `Mockups/Ballot/Everyday/First time/…` (apps/ballot, `everyday-first-*`).

Goal (owner): anyone can vote on anything. The first answer takes three taps at most, and the passkey backup is offered after it, never before.

## The journey

Taps are counted from the stream; Turnstile and setup add none unless Cloudflare asks for a tick.

1. **Website: tap an answer on a card** (tap 1). The link is `https://abolish.ch/#poll=<definition hash>&pick=<option>`: both the poll and the pick are in the fragment, so neither reaches a server, a gateway or a log. A card of several questions offers its first question's answers, so the first tap is still an answer.
2. **Website: "Opening the secure voting app"**, in the same tab, until the voting app paints. It repeats the card's seal, question and the tapped answer, says why in one line ("Your answer is sealed on your device, in an app nobody can change for you") and shows the address, abolish.ch. "Open it now" and "Stay on the website" cover a slow load or a change of mind. Nothing moves; there is no minimum display time.
3. **Voting app: arrival.** The same wordmark, the same seal in the same round mount, the same question styling, and the address beside the wordmark. The tapped answer is selected, with a check and "Selected", and labelled as the person's own choice. A first visit adds one line above: "First time here? This device gets set up while you answer; there's nothing extra to do." It opens to what setup means and to "Use my passkey backup" for someone who has answered on another device.
4. **Voting app: setup, as one still line** beside Send: "Setting up this device to answer", then "This device is set up to answer". Behind it, with no tap: the bot check, the new identity and its registration (below).
5. **Send.**
   - One-question poll: the arrival screen is also the review (the whole ballot is on it, with "Nothing is sent until you tap Send"), so **Send is tap 2. Done: 2 taps.**
   - Three-question poll: Next (2), choose (3), Next (4), choose (5), Check your answers (6), Send my answers (7). **7 taps**, one more for each extra choice in a pick-several question. The three-tap target holds only for one question; the rest are the CCD's one question per screen and the review screen.
   - Cloudflare's interactive fallback adds one tick: **3 taps** for one question. Send before the tick says "Not sent yet: the check above needs to finish first. Your answer is kept."
6. **Sealed and ready to go.** A new device's answer is sealed at once but waits for the device to join its group, which happens in batches (ADR 0024, at most 10 minutes). The screen says so, with a status trail (sealed on this device; this device joins the people who can answer; sent to the public board; counted), and asks the person to leave it open; if they close it, the answer is sent the next time they open the voting app on this device.
7. **The backup offer**, while they wait and again on Done if undecided: "Back up with a passkey?", one sentence of why ("So you can change your answers, and keep answering, from your other devices as the same person"), "Back up with a passkey" and "Not now" side by side, and what skipping means ("you can still answer on this device. A new device would start as someone new. Your receipts stay on this device either way"). Results: backed up; no backup for now; or "This passkey can't hold a backup" when the browser or passkey app has no PRF.
8. **Done**, as on every everyday ballot: "Your answer is in", the receipt seal, save the receipt, change until the close. "Back to the poll's page" returns to the website at `…#from=voting-app`, where a neutral line says the receipt stays in the voting app and the website never learns how, or whether, they answered. The browser's Back button works too, since it's the same tab.

**Returning, same device:** no first-visit line, no setup line; Send goes straight to "Sending your answer" (seconds) and Done. No backup offer.

**New device, no backup:** the same first visit. The disclosure says, in one line, that this device starts as someone new, that answers given on the other device still count, and that changing those takes that device.

**When something goes wrong:**

- Bot check couldn't confirm: "We couldn't confirm you're a person". The answer stays chosen, nothing was sent; try again, or another browser (private windows and some extensions block the check).
- Setup taking long: "Setup is taking longer than usual". The answer is sealed and safe on this device and is sent when setup finishes; keep waiting or come back.
- Offline: "You're offline". The answer is sealed and kept on the device and is sent when back online with the page open, or the next time the app opens; "Try again now".

## Behind each step

- **Turnstile** (ADR 0024, B.2): the widget never runs in the ballot client's bundle. It runs on a separate static challenge page on its own host, which hands the token back by fragment or `postMessage` and never sees the commitment or the answer. The mockup shows it framed inside the setup line at the widget's size, appearing only for the interactive fallback; it starts on arrival so it's usually done before Send.
- **Identity creation**: on arrival, the client makes a Semaphore secret with `packages/crypto` and keeps it in this origin's storage. No account, cookie or name is involved, and the secret never leaves the device unencrypted.
- **Registration**: with the token, the client sends the commitment on the ballot path to the signing service, which queues it and adds it to the group in the next shuffled batch. The client learns that it landed by reading the group's records, never by asking about its commitment.
- **Sealing**: on Send, the answer is encrypted on the device at once. "Sealed" is true from the first second, which is what lets the waiting screens say the answer is safe.
- **Sending**: once the commitment is in the group, the client proves membership and sends the sealed ballot to the board; the receipt follows as for any ballot.
- **Backup** (ADR 0017, option A): a separate discoverable passkey on the voting app's RP ID, its PRF output deriving a wrap key and a locator; the encrypted secret is stored by locator. The backup carries the identity only, not receipts or cast records.

## Decisions made here

- **Same tab, with an interstitial**, not a new tab: one place to come back to (Back, or "Back to the poll's page"), and no stray tab holding a half-finished answer.
- **The pick and the poll in the fragment**, not the path, so even which poll someone opened stays out of the voting app's host and gateway logs.
- **Continuity by repetition**: the wordmark, the seal in its round mount and the question styling appear on the card, the interstitial and the app; the address is shown on both sides so the person can match it to the address bar.
- **For one question, arrival is the review.** The whole ballot is on one screen with the choice marked in words, so a separate check screen would only add a tap. Several questions keep the check screen.
- **Setup is a status, not a step**: no screen, no decision, no spinner. It speaks only when the person has to do something (the tick) or something failed.
- **Send is never blocked by a slow registration**: the answer seals and waits. Only a missing bot check stops it, because without the token nothing can be registered.
- **The backup copy doesn't promise receipts.** The suggested "keep your answers' receipts" contradicts ADR 0017 (receipts and cast records stay on the device), so the reason given is changing answers and answering from other devices as the same person.
- **Offered once.** On the first answer only; later answers don't ask again.

## Open questions for the owner

1. **A first-time voter can't answer a poll that is already open.** [[membership]] proves membership "at the root the election definition fixes for that tier", so a commitment registered after a poll's definition isn't in that poll's root. Everyday polls need a rule for later members (a root that advances with each registration batch, or a set of accepted roots) or this journey can't happen. This is the largest gap, and it's a spec change, not a design one.
2. **The wait before the first answer reaches the board** is up to one registration period (at most 10 minutes). A shorter period at low volume helps the voter but narrows the timing cover (T-13). Should the answer also go out after the tab closes (Background Sync in the ballot client, which its CSP and bundle policy would have to allow)?
3. **How the challenge page joins the client**: a frame (as drawn: needs the challenge host in the client's CSP) or a navigation (adds a page hop to the first answer and needs the in-progress answer kept across it). ADR 0024 leaves this to P3-2 part 4b, along with the challenge host's name.
4. **Audience wording.** The existing everyday fixtures and [[language]] say "people with an account", but under ADR 0024 a Tier 0 voter has no account. These results need new words (for example "among 2,418 people who answered").
5. **Answering twice from two devices.** A voter on a new device without a backup who answers a poll they already answered elsewhere is counted twice (two nullifiers). That's T-01's accepted Tier 0 residual; should the new-device line ask people not to, or say nothing?
6. **Backing up later.** "Back up later from this app" needs a place in the client (a menu or a line on Done); nothing exists yet. Is "offered once" right, or should it come back once after a few answers?
7. **Non-syncing passkeys** (BE clear, ADR 0017 A.2) need their own line ("this backup lives only on this security key"); not drawn here. The restore flow behind "Use my passkey backup" is stubbed; the civic `Recovery` mockup is the reference until an everyday one exists.
8. **A minimum display time for the interstitial** on a first visit, so the address can be read? The design has none.
9. **The several-question card** now offers question 1's answers in the stream; the existing stream card shows a single "Answer 3 questions" button. Keep both, or adopt this one?

## Inconsistencies found in existing mockups

- The website's Riverside seal (`RIVERSIDE.id`, `b1a7…`) and the ballot client's (`RIVERSIDE.definitionHash`, `4095…`) differ, so the two sides show different seals for the same poll. The journey fixtures use `b1a7…` on both.
- The ballot fixtures' `CLIENT.origin` is `vote.abolish.us`, which ADR 0020 rules out (same-site with the website); the journey uses abolish.ch.
