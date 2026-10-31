import fc from "fast-check";
import {
  checkGroupApprovals,
  decodeElectionDefinitionV7,
  decodeGroupAddition,
  decodeGroupRemoval,
  electionDefinitionV7Hash,
  electionStubV7Hash,
  ELECTORATE_MODES,
  groupAdditionDigest,
  groupRegistryDomainSeparator,
  groupRemovalDigest,
  identityKey,
  pinnedVersion,
  POLL_CLASSES,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encodeAbiParameters } from "viem";
import { expect, test } from "vite-plus/test";
import {
  definitionBytes,
  definitionHash,
  type L2Deployment,
  newTrustees,
  placeholder,
  rollingDisplayText,
  runRollingCeremony,
  stubHash,
} from "../src/election.ts";
import { additionRecord, eventBytes, removalRecord } from "../src/groups.ts";
import { ethAddress, newRegistrars } from "../src/l2.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const hex = (b: Uint8Array) => bytesToHex(b);

const l2: L2Deployment = {
  l2ChainId: 31338n,
  electionRegistry: placeholder("test/election-registry"),
  board: placeholder("test/board"),
  trusteeRegistry: placeholder("test/trustee-registry"),
  groupRegistry: placeholder("test/group-registry"),
  l1Relay: placeholder("test/l1-relay"),
};
const timing = {
  l1ChainId: 31337n,
  l1Anchor: placeholder("test/anchor"),
  opensAt: 1_800_000_000n,
  closesAt: 1_800_001_800n,
  inclusionBound: 600,
};
const tier = { tier: 0 as const, root_l2_block: 7n, groups: [0n], root: 12345n, group_size: 3n };
const receiptKey = identityKey(new Uint8Array(32).fill(7));

// A whole key ceremony (ML-KEM challenges among every seat) has taken over
// the 5-second default on CI's runners.
test(
  "the rolling poll's definition is a well-formed version 7 under a rolling electorate, and a civic one breaks rolling-class",
  { timeout: 60_000 },
  () => {
    const trustees = newTrustees();
    const options = { counter: 4n, tier, receiptKeys: [receiptKey] };
    const ran = runRollingCeremony(timing, l2, trustees, rollingDisplayText(), {
      ...options,
      pollClass: POLL_CLASSES.everyday,
    });
    expect(ran.failure).toBeUndefined();
    const d = ran.ceremony.definition;
    expect(d.version).toBe(7);
    expect(d.value.electorate_mode).toBe(ELECTORATE_MODES.rolling);
    expect(d.value.electorate).toEqual([]);
    expect(d.value.rolling_electorate).toEqual([tier]);
    // Rule 9's pins for a rolling version 7: ballot version 5 and its opening's version 3.
    expect(pinnedVersion(d.value, RECORD_TYPES.electionDefinition)).toBe(7);
    expect(pinnedVersion(d.value, RECORD_TYPES.ballot)).toBe(5);
    expect(pinnedVersion(d.value, RECORD_TYPES.spoiledBallotOpening)).toBe(3);
    expect(pinnedVersion(d.value, RECORD_TYPES.contractEvent)).toBe(13);
    // What the registry and the bundle take is version 7's encoding and hashes.
    const bytes = definitionBytes(d);
    expect(decodeElectionDefinitionV7(bytes)).toEqual(d.value);
    expect(hex(definitionHash(d))).toBe(hex(electionDefinitionV7Hash(d.value)));
    expect(hex(stubHash(d))).toBe(hex(electionStubV7Hash(d.value)));

    const civic = runRollingCeremony(timing, l2, trustees, rollingDisplayText(), {
      ...options,
      pollClass: POLL_CLASSES.civicReferendum,
    });
    expect(civic.failure).toEqual({ rule: "rolling-class" });
  },
);

test("registrars are seated in ascending order of their addresses", () => {
  for (let i = 0; i < 20; i++) {
    const addresses = newRegistrars(3).map((s) => hex(ethAddress(s)));
    expect(addresses).toEqual([...addresses].sort());
    expect(new Set(addresses).size).toBe(3);
  }
});

// Each run signs four approvals and recovers three: at CI's 1000 runs that
// takes about 30 seconds.
test(
  "the group records carry what they add or remove, approved by every registrar in seat order",
  { timeout: 300_000 },
  () => {
    const registrarSecrets = newRegistrars(2);
    const registrars = registrarSecrets.map(ethAddress);
    const signers = { l2ChainId: l2.l2ChainId, groupRegistry: l2.groupRegistry, registrarSecrets };
    const separator = groupRegistryDomainSeparator(l2.l2ChainId, l2.groupRegistry);
    // Field elements well inside the field, so none is a forbidden commitment.
    const commitment = fc.bigInt({ min: 2n, max: 1n << 250n });
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1000n }),
        fc.bigInt({ min: 0n, max: 1000n }),
        fc.array(commitment, { minLength: 1, maxLength: 8 }),
        fc.uniqueArray(fc.bigInt({ min: 0n, max: 99n }), { minLength: 1, maxLength: 8 }),
        (groupId, firstIndex, commitments, unsorted) => {
          const added = decodeGroupAddition(
            additionRecord(signers, groupId, firstIndex, commitments),
          );
          if (!added.ok) throw new Error(added.error);
          expect(added.value).toMatchObject({ groupId, firstIndex, commitments });
          const addDigest = groupAdditionDigest(separator, {
            groupId,
            tier: 0,
            firstIndex,
            commitments,
          });
          expect(checkGroupApprovals(addDigest, added.value.approvals, registrars, 2)).toEqual({
            ok: true,
          });

          const indices = [...unsorted].sort((a, b) => (a < b ? -1 : 1));
          const size = 100n;
          const removed = decodeGroupRemoval(removalRecord(signers, groupId, size, indices));
          if (!removed.ok) throw new Error(removed.error);
          expect(removed.value).toMatchObject({ groupId, size, indices });
          const removeDigest = groupRemovalDigest(separator, { groupId, tier: 0, size, indices });
          expect(checkGroupApprovals(removeDigest, removed.value.approvals, registrars, 2)).toEqual(
            {
              ok: true,
            },
          );
          // Signed for another tier, the same approvals recover other keys.
          expect(
            checkGroupApprovals(
              groupAdditionDigest(separator, { groupId, tier: 1, firstIndex, commitments }),
              added.value.approvals,
              registrars,
              2,
            ).ok,
          ).toBe(false);
        },
      ),
      { numRuns },
    );
  },
);

test("an event's record is the bytes its data ABI-encodes", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 300 }), (record) => {
      const data = encodeAbiParameters([{ type: "bytes" }], [`0x${hex(record)}`]);
      expect(hex(eventBytes(Buffer.from(data.slice(2), "hex")))).toBe(hex(record));
    }),
    { numRuns },
  );
  // A length past the data, or data too short to hold one, is refused, never truncated.
  const data = Buffer.from(encodeAbiParameters([{ type: "bytes" }], ["0x0102"]).slice(2), "hex");
  expect(() => eventBytes(data.subarray(0, 64))).toThrow();
  expect(() => eventBytes(data.subarray(0, 40))).toThrow();
});
