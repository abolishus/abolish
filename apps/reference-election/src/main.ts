// `vp run reference-election`: the reference election (AGENTS.md, Reference
// election; P1-20). It runs every stage built so far against a local Anvil,
// writes what it produced to reference-election-output/, has packages/verifier
// check that output in a process of its own, and exits non-zero if any stage
// or any expectation of the verifier's report fails. Stages not built yet are
// listed as such in stages.json (stages.ts).

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Checkpoint,
  copyCheckpoints,
  encodeDisplayText,
  encodeElectionDefinition,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { startAnvil } from "./anvil.ts";
import { boardEntry, displayText, runCeremony, STUBS } from "./election.ts";
import { checkExpectations, checkTamperedCopy } from "./expectations.ts";
import { anchorAt, deployAnchor, evidence, mineAt } from "./l1.ts";
import { anchorSlots } from "./slots.ts";
import { STAGES } from "./stages.ts";
import { runVerifier } from "./verify.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = join(ROOT, "reference-election-output");
const BOARD_ANCHOR = new URL(
  "../../../packages/contracts/out/BoardAnchor.sol/BoardAnchor.json",
  import.meta.url,
);

/** Anvil's default chain ID: a local L1 that no real network uses. */
const L1_CHAIN_ID = 31337n;
// The deployed anchor's period and deadline (docs/spec/contracts.md, Board anchor).
const PERIOD = 3600n;
const DEADLINE = 43_200n;
// How far past a period's end the fixture anchors it: inside the deadline.
const ANCHOR_DELAY = 60n;

const hex = (b: Uint8Array) => bytesToHex(b);
const log = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<number> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "bundle"), { recursive: true });
  const anvil = await startAnvil(L1_CHAIN_ID);
  try {
    const genesis = await anvil.call<{ timestamp: string }>("eth_getBlockByNumber", [
      "latest",
      false,
    ]);
    const now = BigInt(genesis.timestamp);
    // The clock starts a period before now, so the election's first segment is 1.
    const epoch = (now / PERIOD) * PERIOD - PERIOD;
    const clock = { epoch, period: PERIOD, deadline: DEADLINE };
    const anchor = await deployAnchor(anvil, BOARD_ANCHOR, clock);
    const end = (s: number) => epoch + (BigInt(s) + 1n) * PERIOD;
    const first = Number((now - epoch) / PERIOD);
    const seal = first + 1;
    log(`L1: Anvil (chain ${L1_CHAIN_ID}), BoardAnchor at 0x${hex(anchor.address)}`);

    // Stage 1: the ceremony, then the definition that binds its transcript.
    const text = displayText();
    const ceremony = runCeremony(
      {
        l1ChainId: L1_CHAIN_ID,
        l1Anchor: anchor.address,
        opensAt: end(first),
        closesAt: end(first) + PERIOD / 2n,
        inclusionBound: 600,
      },
      text,
    );
    const d = ceremony.definition;
    log(
      `stage 1: ${ceremony.panel.threshold}-of-${ceremony.panel.keys.length} ceremony, transcript ${ceremony.transcript.length} bytes, election 0x${hex(d.election_id)}`,
    );

    // The board: the transcript in the first segment.
    const entries = [boardEntry(d, 0n, first, ceremony.transcript)];
    const atFirst = copyCheckpoints(d.election_id, entries, [first]).get(first);
    if (atFirst === undefined) throw new Error("no checkpoint for the first segment");
    // The seal repeats the board's state: nothing is appended in its period.
    const atSeal: Checkpoint = { ...atFirst, segment: seal };

    // Stage 7: each checkpoint anchored inside its window.
    await anchorAt(anvil, anchor, [atFirst], end(first) + ANCHOR_DELAY);
    await anchorAt(anvil, anchor, [atSeal], end(seal) + ANCHOR_DELAY);
    // Past the seal's deadline, so the board checks see a closed board; then
    // enough blocks that Anvil's finalized block includes both anchors.
    const after = end(seal) + DEADLINE + 1n;
    for (let i = 0n; i < 70n; i++) await mineAt(anvil, after + i * 12n);
    const l1 = await evidence(anvil, anchor.address, anchorSlots(d.election_id, first, seal));
    if (l1.timestamp < after) throw new Error("the finalized block is before the anchors");
    log(`stage 7: segments ${first} and ${seal} (the seal) anchored`);

    const bundle = {
      format: "abolish-verifier-bundle/4",
      definition: hex(encodeElectionDefinition(d)),
      clock: {
        epoch: epoch.toString(),
        period: PERIOD.toString(),
        deadline: DEADLINE.toString(),
        lastSegment: seal.toString(),
      },
      l1: {
        firstSegment: first.toString(),
        header: hex(l1.header),
        nodes: l1.nodes.map(hex),
        checkpoints: [],
      },
      panel: {
        threshold: ceremony.panel.threshold.toString(),
        keys: ceremony.panel.keys.map(hex),
      },
    };
    writeFileSync(join(OUT, "bundle", "bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`);
    writeFileSync(join(OUT, "bundle", "board.bin"), Buffer.concat(entries));
    writeFileSync(join(OUT, "definition.bin"), encodeElectionDefinition(d));
    writeFileSync(join(OUT, "ceremony-transcript.bin"), ceremony.transcript);
    writeFileSync(join(OUT, "display-text.bin"), encodeDisplayText(text));

    // Stage 9: the verifier, on the bundle alone.
    const verified = runVerifier(join(OUT, "bundle"));
    writeFileSync(join(OUT, "verifier-report.json"), verified.stdout);
    const failures = checkExpectations(verified);
    log(`stage 9: verdict ${verified.report.verdict} (every input is a local file)`);

    // A control: the same bundle with one byte of the transcript flipped.
    const tamperedDir = join(OUT, "control-tampered");
    mkdirSync(tamperedDir);
    const tampered = Buffer.concat(entries);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] as number) ^ 1;
    writeFileSync(join(tamperedDir, "bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`);
    writeFileSync(join(tamperedDir, "board.bin"), tampered);
    failures.push(...checkTamperedCopy(runVerifier(tamperedDir)));

    writeFileSync(
      join(OUT, "stages.json"),
      `${JSON.stringify({ stages: STAGES, stubs: STUBS, failures }, null, 2)}\n`,
    );
    for (const f of failures) process.stderr.write(`reference election: ${f}\n`);
    const missing = STAGES.filter((s) => s.coverage !== "covered").map((s) => s.id);
    log(`stages not yet fully covered: ${missing.join(", ")} (stages.json)`);
    return failures.length === 0 ? 0 : 1;
  } finally {
    await anvil.stop();
  }
}

process.exitCode = await main();
