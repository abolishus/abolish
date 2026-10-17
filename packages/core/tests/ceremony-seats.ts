import {
  answersMessage,
  type CeremonyParams,
  type CeremonyTranscript,
  ceremonyKeygen,
  challengesMessage,
  checkCeremonyTranscript,
  decodeCeremonyTranscript,
  decodeElectionDefinitionV5,
  electionStubV5Hash,
  encodeCeremonyTranscript,
  keySetEntry,
  keySetHash,
  keysMessage,
  revealsMessage,
  type SeatSecrets,
  signCeremonyRegistration,
} from "@abolishus/crypto";
import type { Sql } from "postgres";
import {
  type CoordinatorDeployment,
  coordinatorRequests,
  postCeremonyApproval,
  postCeremonyMessage,
} from "../src/index.ts";

// An honest seat of the default panel for the coordinator's tests (P2-22
// part 4c) and the registration step's (part 5a), built from crypto's own
// round functions as apps/trustee-node's seat calls them.

const FIELDS = ["keys", "challenges", "answers", "reveals"] as const;
const EMPTY = { keys: [], challenges: [], answers: [], reveals: [] };

/**
 * One honest seat, as apps/trustee-node's runs it but without its store:
 * fresh keys per run, one message per round over the rounds it is shown,
 * and an approval of a transcript that checks with rule 7's quorum.
 */
export interface SeatOptions {
  readonly deployment: CoordinatorDeployment;
  /** The panel's identity secrets, in seat order. */
  readonly secrets: readonly Uint8Array[];
  /** The client a seat posts through unless `act` is given another. */
  readonly client: () => Sql;
  /** The time a seat posts at unless `act` is given another. */
  readonly now: Date;
}

export class Seat {
  readonly index: number;
  readonly #options: SeatOptions;
  readonly #runs = new Map<
    string,
    { secrets: SeatSecrets; mus?: readonly Uint8Array[]; approved?: boolean }
  >();

  constructor(index: number, options: SeatOptions) {
    this.index = index;
    this.#options = options;
  }

  /** Fetches the seat's requests and answers each; returns what each post got. */
  async act(client: Sql = this.#options.client(), now = this.#options.now): Promise<string[]> {
    const { deployment, secrets } = this.#options;
    const { panel } = deployment;
    const outcomes = [];
    for (const r of await coordinatorRequests(client, deployment, this.index)) {
      const stub = decodeElectionDefinitionV5(r.stub);
      const stubHash = electionStubV5Hash(stub);
      const t = decodeCeremonyTranscript(r.transcript, 1);
      const params: CeremonyParams = {
        l2ChainId: stub.l2_chain_id,
        trusteeRegistry: stub.trustee_registry,
        electionId: stub.election_id,
        stubHash,
        panel,
        runId: t.run_id,
      };
      const key = Buffer.from(t.run_id).toString("hex");
      let run = this.#runs.get(key);
      if (run === undefined) {
        run = { secrets: ceremonyKeygen(this.index, secrets[this.index - 1]!) };
        this.#runs.set(key, run);
      }
      const open = FIELDS.findIndex((f) => t[f].length === 0);
      if (open === -1) {
        const { runId: _, ...election } = params;
        const check = checkCeremonyTranscript(election, r.transcript, 1);
        if (!check.ok) throw new Error("seat: the transcript doesn't check");
        const registration = {
          l2ChainId: params.l2ChainId,
          trusteeRegistry: params.trusteeRegistry,
          index: this.index,
          stubHash,
          ceremonyTranscriptHash: check.hash,
          keySetHash: keySetHash(check.registered.map(keySetEntry)),
        };
        outcomes.push(
          await postCeremonyApproval(
            client,
            deployment,
            this.index,
            {
              stubHash,
              ceremonyTranscriptHash: registration.ceremonyTranscriptHash,
              keySetHash: registration.keySetHash,
              signature: signCeremonyRegistration(secrets[this.index - 1]!, panel, registration),
            },
            { now },
          ),
        );
        continue;
      }
      const message = this.#message(open, params, run, t);
      const post: CeremonyTranscript = { run_id: t.run_id, ...EMPTY, [FIELDS[open]!]: [message] };
      outcomes.push(
        await postCeremonyMessage(
          client,
          deployment,
          this.index,
          { stubHash, transcript: encodeCeremonyTranscript(post) },
          { now },
        ),
      );
    }
    return outcomes;
  }

  #message(
    open: number,
    params: CeremonyParams,
    run: { secrets: SeatSecrets; mus?: readonly Uint8Array[] },
    t: CeremonyTranscript,
  ) {
    if (open === 0) return keysMessage(params, run.secrets);
    if (open === 1) {
      const c = challengesMessage(params, run.secrets, t.keys);
      run.mus = c.secrets;
      return c.message;
    }
    if (open === 2) return answersMessage(params, run.secrets, t.keys, t.challenges);
    return revealsMessage(params, run.secrets, t, run.mus ?? []);
  }
}
