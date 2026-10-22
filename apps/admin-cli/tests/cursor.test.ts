import { REMOVAL_REASONS } from "@abolishus/core";
import fc from "fast-check";
import { expect, test } from "vite-plus/test";
import { UsageError } from "../src/index.ts";
import {
  formatProfileQueueCursor,
  formatQueueCursor,
  parseProfileQueueCursor,
  parseQueueCursor,
} from "../src/moderation.ts";

// The queues' `next` cursors: whatever `queue` or `profile-queue` prints, `--after` reads back to
// the same position, and anything else is a usage error, never a page that
// silently starts elsewhere.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

// Reports keep only the hour, and ISO 8601 spells four-digit years only.
const HOUR = 3_600_000;
const pendingSince = fc
  .integer({ min: Date.UTC(0, 0, 1) / HOUR, max: Date.UTC(9999, 11, 31, 23) / HOUR })
  .map((h) => new Date(h * HOUR));
const reason = fc.constantFrom(...REMOVAL_REASONS);

/** Both properties for one queue's cursor. */
function cursorProperties<C>(
  name: string,
  cursor: fc.Arbitrary<C>,
  format: (c: C) => string,
  parse: (s: string) => C,
) {
  test(`a printed ${name} cursor parses back to the same position`, () => {
    fc.assert(
      fc.property(cursor, (c) => {
        const parsed = parse(format(c));
        expect(parsed).toEqual(c);
        expect(format(parsed)).toBe(format(c));
      }),
      { numRuns },
    );
  });

  test(`any one-character change to a printed ${name} cursor is refused or moves it`, () => {
    fc.assert(
      fc.property(
        cursor,
        fc.nat(),
        fc.constantFrom(..."0123456789abcdefABCDEF-/:.TZ x1z".split("")),
        (c, at, ch) => {
          const s = format(c);
          const i = at % s.length;
          const t = s.slice(0, i) + ch + s.slice(i + 1);
          let parsed;
          try {
            parsed = parse(t);
          } catch (e) {
            expect(e).toBeInstanceOf(UsageError);
            return;
          }
          // Accepted only as the cursor it spells.
          expect(format(parsed)).toBe(t);
        },
      ),
      { numRuns },
    );
  });
}

cursorProperties(
  "queue",
  fc.record({ pendingSince, electionId: fc.uint8Array({ minLength: 32, maxLength: 32 }), reason }),
  formatQueueCursor,
  parseQueueCursor,
);

cursorProperties(
  "profile-queue",
  fc.record({
    pendingSince,
    handle: fc.string({
      unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz234567".split("")),
      minLength: 16,
      maxLength: 16,
    }),
    reason,
  }),
  formatProfileQueueCursor,
  parseProfileQueueCursor,
);
