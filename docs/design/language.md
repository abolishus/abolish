# Design language

How Abolish looks and moves, on top of the brief's [[PROJECT_BRIEF#Design direction]]. The page mockups in each app's Storybook (`Mockups/…`) are the reference for every screen; build the real routes from them.

## The idea

A public record that explains itself as you read it. The archival base (ruled grids, numbered sections, evidence in monospace) stays still and plain; the data moves only in answer to the reader's own scrolling, the way a long-form explainer redraws its chart as each paragraph arrives. Nothing moves on its own.

## Two registers

The brief's two registers share every token, component and motion rule; they differ in what sits on the surface.

**Everyday** (default; most polls are someone asking anyone anything):

- The question is the hero: large, warm, sentence case, nothing above it but who asked and when it closes. Options are big, friendly targets; answering is a tap or two.
- Results are sentences first ("Most people here want better lighting on the river path"), then bars with plain percentages and counts. The tier still leads the result, in words ("among 2,418 people with an account"), never as a code ("Tier 0").
- Evidence lives one step down, behind "How do we know this is real?": a sheet or expandable section holding the fingerprint, receipt, board entry, trustees and the link to the civic record of the same poll. On the surface, the fingerprint appears only as a small seal.
- No `SectionMark` numbering, fewer mono labels, rounder rhythm: more air, larger type, cards with `rounded-xl` where it helps grouping, softer rules (`border-border` only, no heavy totals rules).
- Live results move with the data: when the poll has live results, bars ease to each newly published total (a real batch, never interpolated) and say when ("updated 14:00, 38 new answers"). Sealed polls say plainly when results appear.
- Discovery is a calm stream of questions: one question per card, answerable from the card (handing off to the ballot client), filters by topic and place. No infinite autoplay, no ranking by outrage, no counts of "people viewing now".
- Copy is conversational but plain: "You answered", "Change your answer", "Results so far". Still no exclamation marks, hype or emoji.

**Civic record** (referendums, organisational votes, and the evidence view of any poll): everything below, as first designed.

## Layout

- **The grid is visible.** Sections are separated by full-width hairlines (`border-border`), and totals by a heavy rule (`border-foreground`, 1–2px), like a ledger. Content sits in a 12-column grid at `max-w-6xl`, with a 16px gutter on phones.
- **Numbered sections.** Each major section opens with a `SectionMark` (`01 · Turnout`), so a page reads like clauses in a printed record and can be cited by number.
- **Large, quiet headings.** Page titles in Oxanium at `text-5xl`–`text-7xl`, `font-semibold`, tight leading, never centred over more than one line of body copy. Body copy at `text-base`/`text-lg`, `max-w-prose`.
- **Evidence in the evidence face.** Hashes, entry numbers, times (UTC), CIDs, client hashes and trustee keys are JetBrains Mono (`font-mono`), usually `text-xs` with `tracking-wide`, paired with a `Fingerprint` where a person might compare them.
- **One task per screen** on the ballot client, and on any web page that takes input.

## Colour

Zinc neutrals carry everything. Emerald (`primary`) marks the one thing that matters on a view: the leading option, the reader's own entry, the active step, the primary action. Amber (`pending`) and emerald (`recorded`) are status only; red only for errors. No gradients, glows or tints behind text. Charts use `chart-1`…`chart-5` (an emerald ramp) or foreground at reduced opacity, never a rainbow.

## Motion

From `@abolishus/ui` (all free of runtime dependencies, so the ballot client may use them):

- `reveal`, `draw-x`, `wipe-in`: CSS utilities driven by the element's own view timeline. They settle the element as it scrolls in and do nothing under `prefers-reduced-motion` or in browsers without view timelines.
- `ScrollScene`: a sticky graphic beside a narrative of steps; the graphic redraws for the step at the middle of the viewport and receives the scene's scroll progress (0–1).
- `useScrollProgress(ref)` and `useActiveStep(refs)`: the same signals for custom layouts.
- `TallyBars`, `StatFigure`, `BoardLedger`, `SectionMark`: the data pieces, already wired to the motion above.

Rules:

- Motion reveals data that is already true; it never invents intermediate values that weren't real. A chart that grows with scrolling shows real snapshots (counts at real times), not an interpolated count-up.
- Every number a graphic shows is also in the text beside it, with its scope. The graphic is never the only place a fact appears.
- Results always carry their tier. A scene that walks through tiers shows each tier separately; it never sums them.
- **No motion on the ballot itself.** Choosing, reviewing, challenging and casting are still screens (Center for Civic Design guidance, brief **Keep**). The receipt and the explanations around it may use `reveal`.
- No looping, pulsing, autoplay, count-downs or celebration. Durations 200–500 ms, `ease-out`.

## Data visualisation

- Bars before anything else: `TallyBars` for a result, horizontal and labelled at the bar.
- Time series (turnout over the voting window, entries per hour) as a step line or columns with `chart.tsx` (recharts), on the ruled grid, axis labels in mono. Web only: recharts is not allowed in the ballot client.
- Geography and small cells as a grid of equal tiles (a tile map), never a choropleth that lets area outshout population.
- Annotate directly ("Polls closed 20:00 UTC") instead of legends where possible.

## Voice

As the brief: plain, factual, slightly formal; numbers carry their scope; no exclamation marks, hype or emoji. Mockups use realistic copy so the voice can be reviewed with the layout.
