import { REMOVAL_REASONS } from "@abolishus/core";
import fc from "fast-check";
import { expect, test } from "vite-plus/test";
import { UsageError } from "../src/index.ts";
import { formatQueueCursor, parseQueueCursor } from "../src/moderation.ts";

// The queue's `next` cursor: whatever `queue` prints, `--after` reads back to
// the same position, and anything else is a usage error, never a page that
// silently starts elsewhere.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

// Reports keep only the hour, and ISO 8601 spells four-digit years only.
const HOUR = 3_600_000;
const cursor = fc.record({
  pendingSince: fc
    .integer({ min: Date.UTC(0, 0, 1) / HOUR, max: Date.UTC(9999, 11, 31, 23) / HOUR })
    .map((h) => new Date(h * HOUR)),
  electionId: fc.uint8Array({ minLength: 32, maxLength: 32 }),
  reason: fc.constantFrom(...REMOVAL_REASONS),
});

test("a printed cursor parses back to the same position", () => {
  fc.assert(
    fc.property(cursor, (c) => {
      const parsed = parseQueueCursor(formatQueueCursor(c));
      expect(parsed).toEqual(c);
      expect(formatQueueCursor(parsed)).toBe(formatQueueCursor(c));
    }),
    { numRuns },
  );
});

test("any one-character change to a printed cursor is refused or moves it", () => {
  fc.assert(
    fc.property(
      cursor,
      fc.nat(),
      fc.constantFrom(..."0123456789abcdefABCDEF-/:.TZ x".split("")),
      (c, at, ch) => {
        const s = formatQueueCursor(c);
        const i = at % s.length;
        const t = s.slice(0, i) + ch + s.slice(i + 1);
        let parsed;
        try {
          parsed = parseQueueCursor(t);
        } catch (e) {
          expect(e).toBeInstanceOf(UsageError);
          return;
        }
        // Accepted only as the cursor it spells.
        expect(formatQueueCursor(parsed)).toBe(t);
      },
    ),
    { numRuns },
  );
});
