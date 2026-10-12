// `vp run reference-election`: the reference election (AGENTS.md, Reference
// election; P1-20). It runs every stage built so far against a local Anvil,
// writes what it produced to reference-election-output/, has packages/verifier
// check that output in a process of its own, and exits non-zero if any stage
// or any expectation of the verifier's reports fails. Stages not built yet are
// listed as such in stages.json (stages.ts), which is written however the run
// ends.
//
// Besides the honest election, the run holds controls the verifier must not
// pass, each with the rows it must show, so the honest run's passes can't be
// vacuous: an election whose ceremony two seats sat out (rule 7 of
// [[0006-trustees]]), and the honest bundle with its board copy altered.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Checkpoint,
  copyCheckpoints,
  type ElectionDefinition,
  encodeDisplayText,
  encodeElectionDefinition,
  type Panel,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type Rpc, startAnvil } from "./anvil.ts";
import { boardEntry, displayText, runCeremony, STUBS } from "./election.ts";
import { checkControl, checkExpectations } from "./expectations.ts";
import { anchorAt, type DeployedAnchor, deployAnchor, evidence, mineAt } from "./l1.ts";
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

interface Election {
  readonly name: string;
  readonly definition: ElectionDefinition;
  readonly panel: Panel;
  readonly entries: readonly Uint8Array[];
  /** The checkpoint after the ceremony's segment, and the seal repeating it. */
  readonly checkpoints: readonly [Checkpoint, Checkpoint];
}

function writeBundle(
  dir: string,
  e: Election,
  clock: { epoch: bigint; lastSegment: number },
  l1: { firstSegment: number; header: Uint8Array; nodes: readonly Uint8Array[] },
  board: Uint8Array = Buffer.concat(e.entries),
): void {
  mkdirSync(dir, { recursive: true });
  const bundle = {
    format: "abolish-verifier-bundle/4",
    definition: hex(encodeElectionDefinition(e.definition)),
    clock: {
      epoch: clock.epoch.toString(),
      period: PERIOD.toString(),
      deadline: DEADLINE.toString(),
      lastSegment: clock.lastSegment.toString(),
    },
    l1: {
      firstSegment: l1.firstSegment.toString(),
      header: hex(l1.header),
      nodes: l1.nodes.map(hex),
      checkpoints: [],
    },
    panel: { threshold: e.panel.threshold.toString(), keys: e.panel.keys.map(hex) },
  };
  writeFileSync(join(dir, "bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`);
  writeFileSync(join(dir, "board.bin"), board);
}

/** Verifies `dir`, keeps the report next to it, and returns what fell short. */
function verify(dir: string, judge: (run: ReturnType<typeof runVerifier>) => string[]): string[] {
  const run = runVerifier(dir);
  writeFileSync(`${dir}-report.json`, run.stdout);
  return judge(run);
}

async function run(anvil: Rpc, failures: string[]): Promise<void> {
  const genesis = await anvil.call<{ timestamp: string }>("eth_getBlockByNumber", [
    "latest",
    false,
  ]);
  const now = BigInt(genesis.timestamp);
  // The clock starts a period before now, so the elections' first segment is 1.
  const epoch = (now / PERIOD) * PERIOD - PERIOD;
  const anchor: DeployedAnchor = await deployAnchor(anvil, BOARD_ANCHOR, {
    epoch,
    period: PERIOD,
    deadline: DEADLINE,
  });
  const end = (s: number) => epoch + (BigInt(s) + 1n) * PERIOD;
  const first = Number((now - epoch) / PERIOD);
  const seal = first + 1;
  log(`L1: Anvil (chain ${L1_CHAIN_ID}), BoardAnchor at 0x${hex(anchor.address)}`);

  // Stage 1: each election's ceremony, then its definition and its board,
  // which holds the transcript in the first segment.
  const timing = {
    l1ChainId: L1_CHAIN_ID,
    l1Anchor: anchor.address,
    opensAt: end(first),
    closesAt: end(first) + PERIOD / 2n,
    inclusionBound: 600,
  };
  const elections = (
    [
      ["honest", 0n, 0],
      ["rule-7", 1n, 2],
    ] as const
  ).map(([name, counter, absent]): Election => {
    const text = displayText();
    const c = runCeremony(timing, text, { counter, absent });
    const entries = [boardEntry(c.definition, 0n, first, c.transcript)];
    const atFirst = copyCheckpoints(c.definition.election_id, entries, [first]).get(first);
    if (atFirst === undefined) throw new Error("no checkpoint for the first segment");
    const dir = join(OUT, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "definition.bin"), encodeElectionDefinition(c.definition));
    writeFileSync(join(dir, "ceremony-transcript.bin"), c.transcript);
    writeFileSync(join(dir, "display-text.bin"), encodeDisplayText(text));
    log(
      `stage 1 (${name}): ${c.panel.threshold}-of-${c.panel.keys.length} ceremony with ${c.panel.keys.length - absent} seats, election 0x${hex(c.definition.election_id)}`,
    );
    // The seal repeats the board's state: nothing is appended in its period.
    return {
      name,
      definition: c.definition,
      panel: c.panel,
      entries,
      checkpoints: [atFirst, { ...atFirst, segment: seal }],
    };
  });

  // Stage 7: each period's checkpoints anchored in one call, inside its window.
  await anchorAt(
    anvil,
    anchor,
    elections.map((e) => e.checkpoints[0]),
    end(first) + ANCHOR_DELAY,
  );
  await anchorAt(
    anvil,
    anchor,
    elections.map((e) => e.checkpoints[1]),
    end(seal) + ANCHOR_DELAY,
  );
  // Past the seal's deadline, so the board checks see closed boards; then
  // enough blocks that Anvil's finalized block includes every anchor.
  const after = end(seal) + DEADLINE + 1n;
  for (let i = 0n; i < 70n; i++) await mineAt(anvil, after + i * 12n);

  // Stage 9: the verifier, on each bundle alone.
  for (const e of elections) {
    const l1 = await evidence(
      anvil,
      anchor.address,
      anchorSlots(e.definition.election_id, first, seal),
    );
    if (l1.timestamp < after) throw new Error("the finalized block is before the anchors");
    const clock = { epoch, lastSegment: seal };
    const evidenceFor = { firstSegment: first, header: l1.header, nodes: l1.nodes };
    const dir = join(OUT, e.name, "bundle");
    writeBundle(dir, e, clock, evidenceFor);
    if (e.name === "honest") {
      failures.push(...verify(dir, checkExpectations));
      // A control: the honest bundle with one byte of its transcript flipped.
      // The copy no longer matches its anchors, nor the definition's hash.
      const tampered = Buffer.concat(e.entries);
      const last = tampered.length - 1;
      tampered[last] = (tampered[last] as number) ^ 1;
      const control = join(OUT, "honest", "control-tampered-copy");
      writeBundle(control, e, clock, evidenceFor, tampered);
      failures.push(
        ...verify(control, (r) =>
          checkControl("tampered-copy", r, {
            "3.1": { status: "unverifiable", code: "ceremony-transcript-missing" },
            "3.2": { status: "unverifiable", code: "not-reached" },
            "4.2": { status: "unverifiable", code: "l1-checkpoint-unknown" },
          }),
        ),
      );
    } else {
      // A control: anchored and well formed, but only 5 of 7 seats took part,
      // under rule 7's 6: the verifier must fail the election on 3.2 alone.
      failures.push(
        ...verify(dir, (r) =>
          checkControl("rule-7", r, {
            "3.2": { status: "fail", code: "ceremony-participation" },
            "4.1": { status: "pass" },
            "4.2": { status: "pass" },
          }),
        ),
      );
    }
  }
  log(`stage 7: segments ${first} and ${seal} (the seal) anchored for each election`);
}

async function main(): Promise<number> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const failures: string[] = [];
  try {
    const anvil = await startAnvil(L1_CHAIN_ID);
    try {
      await run(anvil, failures);
    } finally {
      await anvil.stop();
    }
  } catch (e) {
    failures.push(`the run stopped: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  } finally {
    writeFileSync(
      join(OUT, "stages.json"),
      `${JSON.stringify({ stages: STAGES, stubs: STUBS, failures }, null, 2)}\n`,
    );
    for (const f of failures) process.stderr.write(`reference election: ${f}\n`);
    const partial = STAGES.filter((s) => s.coverage !== "covered").map((s) => s.id);
    log(`stages not yet fully covered: ${partial.join(", ")} (stages.json)`);
  }
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
