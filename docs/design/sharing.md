# Sharing

How an everyday poll travels: a link in a group chat, a post, a flyer on a noticeboard, a card on a local news site. Sharing is the growth loop, so it has to work everywhere a link goes, and it has to stay calm ([[PROJECT_BRIEF#Design direction]]: no engagement hooks, no social proof, no urgency). Everything here is in the everyday register ([[language#Two registers]]) except the civic record's link preview.

The mockups are in Storybook: `Mockups/Sharing/…` in apps/web (`share-*`) and `Mockups/Ballot/Everyday/Share` in apps/ballot (`everyday-share-*`).

## What every surface shows, and never shows

Shows: the question, who asked, the place, when it closes, how many answers so far, the poll's seal (its fingerprint) and the short link. A live poll adds its latest published lead, as a sentence and one bar, with the release's date.

Never shows:

- **Anything about a sealed poll's answers.** No percentage, bar, leader, "close race" or ordering of options, on any surface, in the image or in its alt and meta text. Only the count of answers, which the public board shows anyway, and when results appear ("Results when it closes on 15 Nov").
- **Numbers that weren't released.** A live poll shows the latest release's totals and says when it came out ([[0027-trustee-panels-and-live-results]]: totals at set times, in batches of at least `B`). Nothing is interpolated or estimated between releases.
- **Anyone's answer, or whether they answered.** The link is the same for everyone who shares the poll: no per-person code, referral token or `utm_` parameter, so a link can't tie a sharer to the poll, let alone to an answer. The share sheet says so in one line: sharing sends the question and the link, never your answer. The Web Share API gets `{ title, url }` and nothing else.
- **Social proof or nudges.** No "N friends answered", share counts, "trending", streaks, countdowns or "only 2 days left". The closing date is a fact in the byline, never a timer.
- **A blended civic result.** The civic preview shows one row per tier with its own count; never a single headline across tiers.

## Surfaces

### Link preview (Open Graph)

- 1200 × 630 (`og:image`) and 1080 × 1080 (for platforms and posts that prefer square). Always the light palette: it's a picture, and most chats show it on their own ground.
- Type is sized for a 300px-wide thumbnail in a phone chat: the question is 60px on the wide card (about 15px at 300px), clamped to three lines (five on the square). The full question goes in `og:title`.
- Variants: live (lead sentence and bar), sealed (lock, count, when results appear), closed (final result sentence, "Final count"), several questions ("3 questions" chip, the first question's lead labelled "Question 1 of 3"), and the civic record (ruled, mono labels, three tier rows, "Anyone can recount it").
- Text under the image: `og:title` is the question; `og:description` is "Asked by … in …", the count, the lead (or the sealed line) and "Anyone can check the count." No percentage for a sealed poll there either.

### Share sheet

- **Website:** "Share this poll" on the poll page, beside the answer button, opens a dialog: the link with **Copy link**, **Share…** (the system menu), then quieter rows: **Show a QR code** (inline), **Print a flyer**, **Embed on your site** (switches the dialog to the embed panel, with "Back to sharing").
- **Ballot client:** an "Ask others" section on the Done screen, after the receipt and before "Changed your mind?". It never sits above the receipt or in the bottom bar, whose one action stays "See results so far". Flyer and embed open the website in a new tab.
- **Copied:** the button reads "Link copied" with a check, and a status line says "Link copied. Paste it anywhere." A failed copy says to select the link and copy it.
- **No Web Share API** (most desktop browsers): the Share… button isn't shown; one line says the browser has no share menu, and **Email the link** (a `mailto:` with the question as subject) takes its place.
- The fallback line sits at the bottom: "If abolish.us doesn't open where you are: open abolish.ch or abolishus.eth and enter the code 3j55dw1."

### Printable flyer

A4 and US Letter, portrait, at `/p/<code>/flyer`: who it's for and who asked, the question, a large QR code, the short link to type, the closing date and time, "How to answer" and "Anyone can check the count", the fallback line, "Non-binding, run by citizens", and seven tear-off tabs carrying the link. The black-and-white version drops the emerald band and frame, for office printers and photocopies. `@page` sets the paper size with no margin, and printing hides everything but the sheet.

### Embed

A card for local news and community pages: who asked, the question, each option as a link (with its percentage and a thin bar when results are public), the count and release date, **Answer on Abolish** ("Answer 3 questions on Abolish" for several), the short link, and "Answers are taken only on Abolish, never in this card." Light, dark or the reader's setting; it reflows from 320px to 640px.

## The embed decision

**An iframe of a script-free page**, `https://abolish.us/embed/p/<code>`, rendered by apps/web. The snippet:

```html
<iframe
  src="https://abolish.us/embed/p/3j55dw1"
  title="Poll: …"
  width="100%"
  height="604"
  style="max-width:640px;border:0"
  loading="lazy"
  referrerpolicy="no-referrer"
  sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
></iframe>
```

Why:

- **Live results need fresh data.** A pasted HTML snapshot goes stale at the next release; the iframe shows the latest release each time the page is read.
- **No script on either side.** A `<script>` widget would run our code inside other people's pages and theirs beside ours, outside any policy we control (T-67, T-43). The embed page has no script at all; the sandbox withholds scripts and forms from the frame, so even a compromised embed page can't run code or post anything. It keeps the frame's origin (`allow-same-origin`) only so the page's own stylesheet and fonts load: an opaque origin would be refused our `same-origin` assets, and with no script the origin gives the frame nothing else. The page's CSP carries the same sandbox, so it holds where a host leaves the attribute out (P2-24 part 3).
- **It can't take a vote.** The card has no form, input or button; options and "Answer on Abolish" are links with `target="_blank"` to the ballot client, using the same fragment handoff as the website (`https://abolish.ch/#poll=<definition hash>&pick=<option>`, [[first-answer]]), so neither the poll nor the pick reaches a server. The ballot client itself must refuse to be framed (below).

Costs: every reader's browser contacts abolish.us when the host page loads (T-11). The snippet sets `referrerpolicy="no-referrer"` and the embed route sets no cookies, but the host can override the attribute. For sites that don't want that, the dialog offers **a plain link** instead: the question as a link and one line, which loads nothing from us.

Server-side: `/embed/p/<code>` is the only route whose CSP allows framing (`frame-ancestors *`; `'none'` on every other page, `src/security.ts`), with `default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'none'; base-uri 'none'`, the sandbox above, and no `script-src`. Without script the frame can't size itself, so the dialog writes a height for the poll's shape (one question: 420 + 56 per option; several: 640, measured at 320 pixels wide) and the page scrolls inside past that.

## Short links and entry points

**Format:** `abolish.us/p/<code>`, where the code is the first 35 bits of the poll's definition hash (its seal) as 7 characters of lower-case Crockford base32 (`0-9a-z` without `i l o u`), for example `abolish.us/p/3j55dw1`.

- **Anyone can resolve it.** It's a pure function of the board: the earliest poll on the board with that prefix owns the 7-character code, and a later poll whose prefix is taken gets 8 characters (then 9…). So mirrors, `apps/node` and the verifier resolve codes without us, and a poll ground to collide with an existing one can't take its code.
- **Forgiving input.** Codes are case-insensitive; on input `o` reads as `0` and `i`/`l` as `1`. QR codes carry the upper-case form (`HTTPS://ABOLISH.US/P/3J55DW1`, 28 characters), which fits a version 2 code in alphanumeric mode.
- **Paths under it:** `/p/<code>` (the poll page), `/p/<code>/flyer`, `/p/<code>/embed` (the poll page with the embed dialog open, for the ballot client's link), `/embed/p/<code>` (the iframe), and the image (below).
- **Censorship resistance** ([[0020-entry-points]]): if abolish.us is taken down or blocked, the ballot client's entry points take the code: "open abolish.ch or abolishus.eth and enter the code 3j55dw1". Entering a code, not a path on those hosts, keeps the poll out of their request logs and doesn't depend on a gateway's path routing. The line appears where there's room: both share sheets and the flyer; not on the link preview or the embed.

## What the link-preview generator needs

- **apps/web renders it**, from public data only: the definition (question, who asked, place, close), the latest release or the final tally, and the board's answer count. No third-party image service, no account or request data.
- **When:** at each release batch and at close, plus once at opening, with the answer count of a sealed poll refreshed each anchoring period. Versioned URLs (`/og/p/<code>/<release>.png`, `immutable`), and the poll page's `og:image` names the latest; chats cache aggressively, so a new release needs a new URL.
- **A rasteriser.** Chats need PNG (most ignore SVG). We can lay out the card ourselves as SVG, but text needs Oxanium's metrics for line breaking and a PNG encoder: in practice a dependency in apps/web (resvg, or Satori with resvg). That's an owner decision.
- **Fonts** from the self-hosted fontsource files, never a CDN. PNG under about 300 KB.
- **Headers:** the image route is cacheable (unlike pages, which are `no-store`) and sets no cookies.

## QR codes

The mockups draw a clearly labelled placeholder (version 2's grid, finder, timing and alignment patterns, data modules from the poll id; it encodes nothing). A real encoder is needed: byte or alphanumeric mode, Reed–Solomon at level M on screens and Q on print, masking. Recommendation: write a small dependency-free encoder in `packages/ui`, tested against reference vectors, so the website (share sheet, flyer) and the ballot client's share sheet use one implementation without a new runtime package in the ballot bundle. If the owner prefers to keep it out of the ballot client, the website alone needs it and the ballot's "Show a QR code" becomes a link to the flyer page.

## Open questions for the owner

1. **Rasteriser for link previews:** accept a dependency in apps/web (resvg or Satori), or keep previews text-only until one is written?
2. **Embed by iframe:** accept relaxing `frame-ancestors` on `/embed/*` only, and that readers of a host page contact abolish.us? Fixed heights or a later opt-in resize message (which would need script)?
3. **Short codes:** 7 characters from the definition hash, extending on collision. No vanity slugs (they invite impersonation of groups and places). Agree?
4. **QR encoder:** in `packages/ui` for both apps, or apps/web only?
5. **Framing the ballot client:** the client can't set `frame-ancestors` from a `<meta>` policy. Our hosts must send it as a header; a gateway such as eth.limo may not, so the client should also refuse to run when framed. Confirm as a requirement on P2-8.
6. **Sealed polls' answer counts:** the cards show "1,206 answers so far" (public on the board). Keep, or show only "Results when it closes"?
7. **Flyer paper default:** A4 everywhere, or Letter for US locales? Translations of the flyer for multilingual neighbourhoods?
8. **Fixtures:** the ballot client's RIVERSIDE has a different definition hash from the website's, so its share link reads `82axrdr` where the website's three-question poll reads `p6kh40x`.
