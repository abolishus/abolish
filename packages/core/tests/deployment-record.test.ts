// The deployment record built from the deploy script's two chain files and
// the owner's inputs (P2-32 part 2a). The chain files under
// fixtures/deployment/ are the ones packages/contracts/test/deploy.test.ts
// wrote on the local Anvil pair, only indented, so the reader here reads
// what the script writes. The record must decode, hash as crypto hashes it and
// carry each file's value where the spec puts it; the two files must agree
// on one deployment; anything malformed is named by its file and path; and
// an ill-formed record is refused with crypto's rule.

import {
  decodeDeploymentRecord,
  deploymentHash,
  generateTier0TokenKeyPair,
  panelId,
} from "@abolishus/crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  buildDeploymentRecord,
  type DeploymentRecordError,
  DeploymentRecordRefused,
} from "../src/deployment-record.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

type Json = Record<string, unknown>;
const fixture = (name: string): Json =>
  JSON.parse(readFileSync(new URL(`fixtures/deployment/${name}`, import.meta.url), "utf8")) as Json;
const L1 = fixture("31337.json");
const L2 = fixture("31338.json");
const clone = <T>(v: T): T => structuredClone(v);

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const bytes = (s: string) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ""), "hex"));
const text = (s: string) => new TextEncoder().encode(s);

const l2Pins = L2["pins"] as {
  launchPanel: { id: string; threshold: number; size: number; keys: string };
  registrars: { threshold: number; addresses: string[] };
};
const seatKeys = Array.from(
  { length: l2Pins.launchPanel.size },
  (_, i) => `0x${l2Pins.launchPanel.keys.slice(2 + i * 66, 2 + (i + 1) * 66)}`,
);
const tokenKeys = [generateTier0TokenKeyPair(), generateTier0TokenKeyPair()].map((k) =>
  hex(k.publicKey),
);

function inputs(overrides: Json = {}): Json {
  return {
    l2FromBlock: "0",
    l2MaxSequencerDrift: 1800,
    disputeGameTypes: [0, 1],
    ours: seatKeys.map((_, i) => i === 0),
    groups: [
      { groupId: "1", tier: 0, selfPaid: false, region: 0 },
      { groupId: "2", tier: 0, selfPaid: true, region: 0 },
    ],
    api: ["https://api.staging.example"],
    l2Rpc: ["https://l2.staging.example"],
    l1Rpc: ["https://l1.staging.example"],
    backupRpId: "ballot-staging.example",
    backups: true,
    accountRpId: "staging.example",
    membershipZkeySha256: `0x${"11".repeat(32)}`,
    membershipWasmSha256: `0x${"22".repeat(32)}`,
    tier0TokenKeys: [],
    seatRelays: [],
    ...overrides,
  };
}

function refusal(l1: unknown, l2: unknown, off: unknown): DeploymentRecordError {
  try {
    buildDeploymentRecord(l1, l2, off);
  } catch (e) {
    if (e instanceof DeploymentRecordRefused) return e.error;
    throw e;
  }
  throw new Error("built a record");
}

describe("buildDeploymentRecord", () => {
  test("puts each chain file's values where the spec puts them", () => {
    const built = buildDeploymentRecord(L1, L2, inputs());
    expect(built.record.version).toBe(1);
    const v = built.record.value;
    const l1 = L1["contracts"] as Record<string, { address: string }>;
    const l2 = L2["contracts"] as Record<string, { address: string }>;
    const l1Pins = L1["pins"] as {
      anchor: { epoch: number; period: number; deadline: number; authority: { address: string } };
      portal: string;
    };
    expect(v.l1_chain_id).toBe(31337n);
    expect(v.l2_chain_id).toBe(31338n);
    expect(hex(v.election_registry)).toBe(l2["ElectionRegistry"]!.address.toLowerCase());
    expect(hex(v.board)).toBe(l2["Board"]!.address.toLowerCase());
    expect(hex(v.trustee_registry)).toBe(l2["TrusteeRegistry"]!.address.toLowerCase());
    expect(hex(v.group_registry)).toBe(l2["GroupRegistry"]!.address.toLowerCase());
    expect(hex(v.l1_anchor)).toBe(l1["BoardAnchor"]!.address.toLowerCase());
    expect(hex(v.l1_relay)).toBe(l1["BallotRelay"]!.address.toLowerCase());
    expect(hex(v.l1_portal)).toBe(l1Pins.portal.toLowerCase());
    expect(hex(v.anchor_authority)).toBe(l1Pins.anchor.authority.address.toLowerCase());
    expect([v.anchor_epoch, v.anchor_period, v.anchor_deadline]).toEqual([
      BigInt(l1Pins.anchor.epoch),
      BigInt(l1Pins.anchor.period),
      BigInt(l1Pins.anchor.deadline),
    ]);
    expect(Buffer.from(v.contracts_commit).toString("hex")).toBe(L1["commit"]);
    expect(v.registrar_threshold).toBe(l2Pins.registrars.threshold);
    expect(v.registrars.map(hex)).toEqual(l2Pins.registrars.addresses.map((a) => a.toLowerCase()));
    expect(hex(v.initial_panel)).toBe(l2Pins.launchPanel.id);
    expect(v.panels).toHaveLength(1);
    expect(v.panels[0]!.threshold).toBe(l2Pins.launchPanel.threshold);
    expect(v.panels[0]!.seats.map((s) => hex(s.key))).toEqual(seatKeys);
    expect(v.panels[0]!.seats.map((s) => s.ours)).toEqual(seatKeys.map((_, i) => i === 0));
    expect(hex(panelId({ threshold: v.panels[0]!.threshold, keys: seatKeys.map(bytes) }))).toBe(
      l2Pins.launchPanel.id,
    );
  });

  test("returns one encoding a strict reader decodes back, and its deployment hash", () => {
    const built = buildDeploymentRecord(L1, L2, inputs());
    expect(decodeDeploymentRecord(built.encoding)).toEqual(built.record);
    expect(built.hash).toEqual(deploymentHash(built.encoding));
  });

  test("takes the lowest version that carries the inputs", () => {
    const keys = tokenKeys.map((key, i) => ({ period: 700 + i, key, retired: false }));
    const relays = [{ key: seatKeys[2], relays: [{ origin: "https://relay.example", path: "" }] }];
    expect(buildDeploymentRecord(L1, L2, inputs()).record.version).toBe(1);
    const v2 = buildDeploymentRecord(L1, L2, inputs({ tier0TokenKeys: keys })).record;
    expect(v2.version).toBe(2);
    const v3 = buildDeploymentRecord(
      L1,
      L2,
      inputs({ tier0TokenKeys: keys, seatRelays: relays }),
    ).record;
    expect(v3.version).toBe(3);
    if (v3.version !== 3) return;
    expect(v3.value.tier0_token_keys.map((k) => k.period)).toEqual([700, 701]);
    expect(v3.value.seat_relays.map((s) => hex(s.key))).toEqual([seatKeys[2]]);
    // Relays without token keys are still version 3, which then breaks its rule.
    expect(refusal(L1, L2, inputs({ seatRelays: relays }))).toEqual({
      code: "ill-formed",
      failure: { rule: "token-keys-empty" },
    });
  });

  test("puts every list the spec orders in its order, whatever order the inputs give", () => {
    const keys = tokenKeys.map((key, i) => ({ period: 700 + i, key, retired: false }));
    const relays = seatKeys.slice(0, 3).map((key, i) => ({
      key,
      relays: [
        { origin: `https://relay-b${i}.example`, path: "seal" },
        { origin: `https://relay-a${i}.example`, path: "" },
      ],
    }));
    const base = inputs({
      api: ["https://api-b.example", "https://api-a.example"],
      disputeGameTypes: [1, 0, 254],
      groups: [
        { groupId: "4", tier: 0, selfPaid: true, region: 7 },
        { groupId: "1", tier: 0, selfPaid: false, region: 0 },
        { groupId: "3", tier: 0, selfPaid: false, region: 7 },
        { groupId: "2", tier: 0, selfPaid: true, region: 0 },
      ],
      tier0TokenKeys: keys,
      seatRelays: relays,
    });
    const expected = buildDeploymentRecord(L1, L2, base).encoding;
    const shuffled = <T>(list: readonly T[]) =>
      fc.shuffledSubarray([...list], { minLength: list.length, maxLength: list.length });
    fc.assert(
      fc.property(
        shuffled(base["api"] as string[]),
        shuffled(base["disputeGameTypes"] as number[]),
        shuffled(base["groups"] as Json[]),
        shuffled(keys),
        shuffled(relays),
        fc.boolean(),
        (api, games, groups, tier0TokenKeys, seatRelays, flip) => {
          const off = inputs({
            api,
            disputeGameTypes: games,
            groups,
            tier0TokenKeys,
            seatRelays: seatRelays.map((s) => ({
              key: s.key,
              relays: flip ? [...s.relays].reverse() : s.relays,
            })),
          });
          expect(buildDeploymentRecord(L1, L2, off).encoding).toEqual(expected);
        },
      ),
      { numRuns },
    );
  }, 120_000);

  test("refuses two chain files that aren't one deployment", () => {
    const cases: [DeploymentRecordError, (l1: Json, l2: Json) => void][] = [
      [{ code: "mismatch", what: "target" }, (_, l2) => (l2["target"] = "production")],
      [{ code: "mismatch", what: "commit" }, (_, l2) => (l2["commit"] = "0".repeat(40))],
      [
        { code: "mismatch", what: "deployer" },
        (_, l2) => (l2["deployer"] = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
      ],
      // Each file's chain is the one the other's pins name.
      [{ code: "mismatch", what: "l1-chain" }, (l1) => (l1["chainId"] = 11155111)],
      [{ code: "mismatch", what: "l2-chain" }, (_, l2) => (l2["chainId"] = 84532)],
      [
        { code: "mismatch", what: "board" },
        (l1) => ((l1["pins"] as Json)["board"] = `0x${"ab".repeat(20)}`),
      ],
      [
        { code: "mismatch", what: "anchor" },
        (_, l2) => ((l2["pins"] as Json)["l1Anchor"] = `0x${"ab".repeat(20)}`),
      ],
      [
        { code: "mismatch", what: "relay" },
        (_, l2) => ((l2["pins"] as Json)["l1Relay"] = `0x${"ab".repeat(20)}`),
      ],
      [{ code: "mismatch", what: "epoch" }, (_, l2) => ((l2["pins"] as Json)["epoch"] = 3600)],
    ];
    for (const [expected, mutate] of cases) {
      const l1 = clone(L1);
      const l2 = clone(L2);
      mutate(l1, l2);
      expect(refusal(l1, l2, inputs())).toEqual(expected);
    }
    // The files swapped: the L2's has no anchor among its pins.
    expect(refusal(L2, L1, inputs())).toEqual({
      code: "malformed",
      source: "l1",
      path: ".pins.anchor",
    });
  });

  test("refuses a launch panel whose keys aren't the ones its identifier pins", () => {
    const l2 = clone(L2);
    const panel = (l2["pins"] as Json)["launchPanel"] as Json;
    // Seats 1 and 2 swapped: the same keys, so only the identifier tells.
    const swapped = [seatKeys[1], seatKeys[0], ...seatKeys.slice(2)].map((k) => k!.slice(2));
    panel["keys"] = `0x${swapped.join("")}`;
    expect(refusal(L1, l2, inputs())).toEqual({ code: "panel-id" });
    panel["threshold"] = (panel["threshold"] as number) + 1;
    panel["keys"] = l2Pins.launchPanel.keys;
    expect(refusal(L1, l2, inputs())).toEqual({ code: "panel-id" });
  });

  test("refuses an ours flag list that isn't one per seat", () => {
    for (const ours of [
      [],
      seatKeys.map(() => false).slice(1),
      [...seatKeys.map(() => false), false],
    ])
      expect(refusal(L1, L2, inputs({ ours }))).toEqual({ code: "seats" });
  });

  test("names the file and path of the first malformed value", () => {
    const cases: [Json, Json, Json, DeploymentRecordError][] = [];
    const add = (
      source: "l1" | "l2" | "inputs",
      path: string,
      mutate: (l1: Json, l2: Json, off: Json) => void,
    ) => {
      const l1 = clone(L1);
      const l2 = clone(L2);
      const off = inputs();
      mutate(l1, l2, off);
      cases.push([l1, l2, off, { code: "malformed", source, path }]);
    };
    add("l1", ".commit", (l1) => (l1["commit"] = `0x${"ab".repeat(20)}`));
    add("l1", ".commit", (l1) => (l1["commit"] = "AB".repeat(20)));
    add("l1", ".chainId", (l1) => (l1["chainId"] = 2 ** 53));
    add("l1", ".chainId", (l1) => (l1["chainId"] = "31337"));
    add("l1", ".deployer", (l1) => (l1["deployer"] = `0x${"ab".repeat(19)}`));
    add("l1", ".contracts.BallotRelay", (l1) => delete (l1["contracts"] as Json)["BallotRelay"]);
    add("l2", ".pins.launchPanel.keys", (_, l2) => {
      const p = (l2["pins"] as Json)["launchPanel"] as Json;
      p["size"] = (p["size"] as number) + 1;
    });
    add("l2", ".pins.launchPanel.kind", (_, l2) => {
      ((l2["pins"] as Json)["launchPanel"] as Json)["kind"] = 0;
    });
    add("inputs", ".l2_rpc", (_, __, off) => (off["l2_rpc"] = []));
    add("inputs", ".l2FromBlock", (_, __, off) => (off["l2FromBlock"] = 0));
    add("inputs", ".l2FromBlock", (_, __, off) => (off["l2FromBlock"] = "18446744073709551616"));
    add("inputs", ".l2FromBlock", (_, __, off) => (off["l2FromBlock"] = "01"));
    add("inputs", ".groups[1].tier", (_, __, off) => {
      (off["groups"] as Json[])[1]!["tier"] = 2;
    });
    add("inputs", ".groups[0].name", (_, __, off) => {
      (off["groups"] as Json[])[0]!["name"] = "x";
    });
    add("inputs", ".membershipZkeySha256", (_, __, off) => (off["membershipZkeySha256"] = "11"));
    add("inputs", ".backups", (_, __, off) => (off["backups"] = "true"));
    add("inputs", ".api[0]", (_, __, off) => (off["api"] = [1]));
    add("inputs", ".seatRelays", (_, __, off) => delete off["seatRelays"]);
    for (const [l1, l2, off, expected] of cases) expect(refusal(l1, l2, off)).toEqual(expected);
    expect(refusal(null, L2, inputs())).toEqual({ code: "malformed", source: "l1", path: "." });
    expect(refusal(L1, L2, [])).toEqual({ code: "malformed", source: "inputs", path: "." });
  });

  test("refuses a record that breaks a well-formedness rule, with the rule", () => {
    const l2 = clone(L2);
    ((l2["pins"] as Json)["registrars"] as Json)["threshold"] = 1;
    expect(refusal(L1, l2, inputs())).toEqual({
      code: "ill-formed",
      failure: { rule: "registrar-threshold" },
    });
    // Two of an independent panel's seats ours ([[0006-trustees]] rule 3);
    // the fixture's launch panel is transitional, which may hold more.
    const independent = clone(L2);
    ((independent["pins"] as Json)["launchPanel"] as Json)["kind"] = 1;
    const twoOurs = inputs({ ours: seatKeys.map((_, i) => i < 2) });
    expect(buildDeploymentRecord(L1, L2, twoOurs).record.value.panels[0]!.kind).toBe(2);
    expect(refusal(L1, independent, twoOurs)).toEqual({
      code: "ill-formed",
      failure: { rule: "panel-kind", panel: 0 },
    });
    const cases: [Json, DeploymentRecordError][] = [
      [{ disputeGameTypes: [] }, { code: "ill-formed", failure: { rule: "game-types" } }],
      [{ disputeGameTypes: [1, 1] }, { code: "ill-formed", failure: { rule: "game-types" } }],
      [{ l2MaxSequencerDrift: 0 }, { code: "ill-formed", failure: { rule: "drift" } }],
      [{ groups: [] }, { code: "ill-formed", failure: { rule: "groups-empty" } }],
      [
        { groups: [{ groupId: "1", tier: 0, selfPaid: false, region: 0 }] },
        { code: "ill-formed", failure: { rule: "group-region" } },
      ],
      [
        { l1Rpc: ["http://l1.example"] },
        { code: "ill-formed", failure: { rule: "origin", list: "l1_rpc" } },
      ],
      [
        { api: ["https://a.example", "https://a.example"] },
        { code: "ill-formed", failure: { rule: "origin-order", list: "api" } },
      ],
      [
        { l1Rpc: ["https://api.staging.example"] },
        { code: "ill-formed", failure: { rule: "origin-shared" } },
      ],
      [
        { accountRpId: "ballot-staging.example" },
        { code: "ill-formed", failure: { rule: "rp-id-shared" } },
      ],
      [
        { tier0TokenKeys: [{ period: 700, key: `0x${"00".repeat(32)}`, retired: false }] },
        { code: "ill-formed", failure: { rule: "token-key", key: 0 } },
      ],
      [
        {
          tier0TokenKeys: [{ period: 700, key: tokenKeys[0], retired: false }],
          seatRelays: [
            { key: `0x02${"ab".repeat(32)}`, relays: [{ origin: "https://r.example", path: "" }] },
          ],
        },
        { code: "ill-formed", failure: { rule: "relay-seat", seat_relay: 0 } },
      ],
    ];
    for (const [overrides, expected] of cases)
      expect(refusal(L1, L2, inputs(overrides)), JSON.stringify(overrides)).toEqual(expected);
  });

  test("carries the inputs' text and hashes as given", () => {
    const v = buildDeploymentRecord(L1, L2, inputs()).record.value;
    expect(v.api).toEqual([text("https://api.staging.example")]);
    expect(v.backup_rp_id).toEqual(text("ballot-staging.example"));
    expect(v.account_rp_id).toEqual(text("staging.example"));
    expect(v.backups).toBe(true);
    expect(v.membership_zkey_sha256).toEqual(bytes("11".repeat(32)));
    expect(v.l2_max_sequencer_drift).toBe(1800n);
  });
});
