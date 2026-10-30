import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { type ContractEventRecord, ELECTORATE_MODES } from "@abolishus/crypto";
import { decodeDefinition } from "../src/definition.ts";
import { definitionRegistration, registrationCheck } from "../src/index.ts";
import { hex, numRuns, read } from "./registry-logs.ts";
import {
  type AnyDefinition,
  ceremonyRegistered,
  definitionRegistered,
  encodingOf,
  KEY_SET,
  OTHER_KEY_SET,
  releaseOf,
  v1Definition,
  v5Definition,
  v7Definition,
} from "./registration-logs.ts";

// The registration from L2 state (docs/spec/verifier.md, Registration) over
// the registries' logs as they emit them (tests/registration-logs.ts): the
// key set and its hash are key-set.json's (T-34, T-37, T-71).

const v5 = v5Definition();
const honest = (d: AnyDefinition = v5, version?: number): ContractEventRecord[] => [
  ceremonyRegistered(d, version === undefined ? {} : { version }),
  definitionRegistered(d),
];
const check = (records: readonly ContractEventRecord[], d: AnyDefinition = v5, keySet = KEY_SET) =>
  registrationCheck(d, keySet, records, releaseOf(d));
const fail = (code: string) => ({ status: "fail", code });
const flip = (b: Uint8Array, at = 0) => {
  const c = b.slice();
  c[at] = (c[at] as number) ^ 1;
  return c;
};

describe("registrationCheck", () => {
  test("passes a definition registered once over the ceremony that recorded its key set", () => {
    expect(check(honest())).toEqual({ status: "pass" });
    // Under every contract-event version from 2 on, the key-set layout.
    for (const version of [2, 8, 11, 12])
      expect(
        check(honest(v5Definition(version), version), v5Definition(version)),
        `${version}`,
      ).toEqual({ status: "pass" });
  });

  test("reads a version-7 definition's registration only under contract-event version 13", () => {
    const v7 = v7Definition();
    expect(check(honest(v7, 13), v7)).toEqual({ status: "pass" });
    const later = { ...v7, value: { ...v7.value, closes_at: v7.value.closes_at + 1n } };
    expect(
      check(
        [ceremonyRegistered(v7, { version: 13 }), definitionRegistered(v7, encodingOf(later))],
        v7,
      ),
    ).toEqual(fail("definition-registered"));
    // Version 12's `DefinitionRegistered` decodes no version-7 definition
    // (T-53).
    const v12 = v7Definition(12);
    expect(check(honest(v12, 12), v12)).toEqual(fail("registry-records"));
  });

  test("leaves a rolling definition with an author panel unverifiable, as a fixed one", () => {
    // Its author run is read as a fixed poll's is (Key ceremony, step 5), so
    // its registration is no more read here than theirs (T-37).
    const authored = v7Definition(13, true);
    expect(authored.value.electorate_mode).toBe(ELECTORATE_MODES.rolling);
    expect(authored.value.author_keys.length).not.toBe(0);
    expect(check(honest(authored, 13), authored)).toEqual({
      status: "unverifiable",
      code: "author-panel",
    });
  });

  test("passes version 1's record, which logs no key set, on its transcript alone", () => {
    const v1 = v1Definition(1);
    expect(check(honest(v1, 1), v1)).toEqual({ status: "pass" });
    // The key set comes from the caller's own transcript check, so the
    // check has nothing to compare it with under version 1.
    expect(check(honest(v1, 1), v1, OTHER_KEY_SET)).toEqual({ status: "pass" });
  });

  test("fails a recorded key set other than the transcript check's", () => {
    expect(check(honest(), v5, OTHER_KEY_SET)).toEqual(fail("key-set-mismatch"));
    const other = [ceremonyRegistered(v5, { keySet: "key-set-6-of-7" }), definitionRegistered(v5)];
    expect(check(other)).toEqual(fail("key-set-mismatch"));
  });

  test("fails an election with no registration, another definition or a second one", () => {
    expect(check([ceremonyRegistered(v5)])).toEqual(fail("definition-unregistered"));
    const later = { ...v5, value: { ...v5.value, closes_at: v5.value.closes_at + 1n } };
    // Logged under the honest hash's topic: the bytes decide, not the topic.
    expect(check([ceremonyRegistered(v5), definitionRegistered(v5, encodingOf(later))])).toEqual(
      fail("definition-registered"),
    );
    expect(check([...honest(), definitionRegistered(v5, undefined, undefined, 30n)])).toEqual(
      fail("definition-registered"),
    );
    // Another election's registration is no registration of this one.
    const elsewhere = { ...v5, value: { ...v5.value, election_id: flip(v5.value.election_id) } };
    expect(check([ceremonyRegistered(v5), definitionRegistered(elsewhere)])).toEqual(
      fail("definition-unregistered"),
    );
  });

  test("fails a stub and panel with no ceremony, another transcript or a second one", () => {
    expect(check([definitionRegistered(v5)])).toEqual(fail("ceremony-unregistered"));
    const transcript = flip(v5.value.ceremony_transcript_hash);
    expect(
      check([
        ceremonyRegistered(v5, {
          transcriptHash: transcript,
          header: { transcriptHash: transcript },
        }),
        definitionRegistered(v5),
      ]),
    ).toEqual(fail("ceremony-registered"));
    expect(check([...honest(), ceremonyRegistered(v5, {}, 16n)])).toEqual(
      fail("ceremony-registered"),
    );
    // Another stub's or another panel's ceremony is none of this one's.
    for (const changes of [
      { stubHash: flip(new Uint8Array(32)) },
      { panelId: flip(v5.value.panel_id) },
    ])
      expect(check([ceremonyRegistered(v5, changes), definitionRegistered(v5)])).toEqual(
        fail("ceremony-unregistered"),
      );
  });

  test("fails a logged record whose header names another ceremony than its topics", () => {
    for (const header of [
      { panelId: flip(v5.value.panel_id) },
      { stubHash: new Uint8Array(32) },
      { transcriptHash: flip(v5.value.ceremony_transcript_hash) },
    ]) {
      expect(check([ceremonyRegistered(v5, { header }), definitionRegistered(v5)])).toEqual(
        fail("registry-records"),
      );
      const v1 = v1Definition(1);
      expect(
        check([ceremonyRegistered(v1, { version: 1, header }), definitionRegistered(v1)], v1),
      ).toEqual(fail("registry-records"));
    }
  });

  test("fails a record of either registry that fails the event check", () => {
    const [ceremony, definition] = honest() as [ContractEventRecord, ContractEventRecord];
    expect(check([{ ...ceremony, data: ceremony.data.subarray(0, 64) }, definition])).toEqual(
      fail("registry-records"),
    );
    expect(check([ceremony, { ...definition, topics: definition.topics.slice(0, 2) }])).toEqual(
      fail("registry-records"),
    );
    // Version 1's layout under a version-8 pin, and the other way round.
    expect(check(honest(v5, 1))).toEqual(fail("registry-records"));
    const v1 = v1Definition(1);
    expect(check(honest(v1, 8), v1)).toEqual(fail("registry-records"));
  });

  test("ignores other contracts' records, whatever they log", () => {
    const [ceremony, definition] = honest() as [ContractEventRecord, ContractEventRecord];
    const elsewhere = { ...definition, contract: flip(definition.contract) };
    expect(check([ceremony, definition, { ...elsewhere, data: new Uint8Array(3) }])).toEqual({
      status: "pass",
    });
    expect(check([ceremony, elsewhere])).toEqual(fail("definition-unregistered"));
  });

  test("fails a definition naming another L2 or registries than the release pins", () => {
    const release = releaseOf(v5);
    for (const changed of [
      { ...release, chainId: release.chainId + 1n },
      { ...release, electionRegistry: flip(release.electionRegistry) },
      { ...release, trusteeRegistry: flip(release.trusteeRegistry) },
    ])
      expect(registrationCheck(v5, KEY_SET, honest(), changed)).toEqual(fail("registries"));
  });

  test("leaves an unread contract-event pin unverifiable", () => {
    for (const version of [0, 14])
      expect(check(honest(), v5Definition(version))).toEqual({
        status: "unverifiable",
        code: "unsupported-version",
      });
  });

  test("leaves a definition with an author panel unverifiable, its registration not read here", () => {
    const authored = read<{ vectors: readonly { encoding?: string }[] }>(
      "election-definition-v6.json",
    )
      .vectors.flatMap((v) => {
        if (v.encoding === undefined) return [];
        try {
          return [decodeDefinition(hex(v.encoding))];
        } catch {
          return [];
        }
      })
      .find((d) => d.version === 6 && d.value.author_threshold !== 0);
    if (authored?.version !== 6) throw new Error("no version-6 vector with an author panel");
    const d = authored.value;
    const release = {
      chainId: d.l2_chain_id,
      electionRegistry: d.election_registry,
      trusteeRegistry: d.trustee_registry,
    };
    expect(registrationCheck(authored, KEY_SET, [], release)).toEqual({
      status: "unverifiable",
      code: "author-panel",
    });
  });

  test("passes the honest records shuffled among unrelated ones, and fails with either dropped", () => {
    const records = honest();
    const elsewhere = { ...v5, value: { ...v5.value, election_id: flip(v5.value.election_id) } };
    const unrelated: ContractEventRecord[] = [
      // Another election's registration and another stub's ceremony.
      definitionRegistered(elsewhere),
      ceremonyRegistered(v5, { stubHash: new Uint8Array(32).fill(7) }),
      // Whatever another contract logs.
      { ...(records[1] as ContractEventRecord), contract: new Uint8Array(20).fill(9) },
    ];
    fc.assert(
      fc.property(
        // Every honest record and some unrelated ones, in any order.
        fc.shuffledSubarray(unrelated).chain((extra) =>
          fc.shuffledSubarray([...records, ...extra], {
            minLength: records.length + extra.length,
          }),
        ),
        fc.integer({ min: 0, max: 1 }),
        (shuffled, dropped) => {
          expect(check(shuffled)).toEqual({ status: "pass" });
          const without = shuffled.filter((r) => r !== records[dropped]);
          expect(check(without).status).toBe("fail");
        },
      ),
      { numRuns },
    );
  });
});

// The registration check's steps 1 to 3 over the election registry alone,
// which a rolling poll's chain takes its registration time from
// (docs/spec/verifier.md, Electorate, The rolling chain; P2-17 part 4d-2b).
describe("definitionRegistration", () => {
  const registration = (records: readonly ContractEventRecord[], d: AnyDefinition = v5) =>
    definitionRegistration(d, records, releaseOf(d));

  test("gives the record that registered the definition, whatever the trustee registry logs", () => {
    const record = definitionRegistered(v5);
    expect(registration([record])).toEqual({ status: "pass", record });
    // No ceremony is read, and a trustee-registry record that fails the
    // event check is the full check's to report.
    const broken = { ...ceremonyRegistered(v5), topics: [] };
    expect(registration([broken, record])).toEqual({ status: "pass", record });
    expect(check([broken, record])).toEqual(fail("registry-records"));
  });

  test("fails and stops as the registration check's steps 1 to 3 do", () => {
    const later = { ...v5, value: { ...v5.value, closes_at: v5.value.closes_at + 1n } };
    for (const records of [
      [],
      [definitionRegistered(v5, encodingOf(later))],
      [definitionRegistered(v5), definitionRegistered(v5, undefined, undefined, 30n)],
      [{ ...definitionRegistered(v5), topics: [] }],
    ]) {
      const full = check([ceremonyRegistered(v5), ...records]);
      expect(full.status).toBe("fail");
      expect(registration(records)).toEqual(full);
    }
    const other = { ...releaseOf(v5), electionRegistry: new Uint8Array(20).fill(3) };
    expect(definitionRegistration(v5, [definitionRegistered(v5)], other)).toEqual(
      fail("registries"),
    );
    const unread = v5Definition(14);
    expect(registration([definitionRegistered(unread)], unread)).toEqual({
      status: "unverifiable",
      code: "unsupported-version",
    });
  });
});
