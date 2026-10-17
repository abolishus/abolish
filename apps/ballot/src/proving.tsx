import { Button, useTranslate } from "@abolishus/ui";
import { Progress, ProgressLabel } from "@abolishus/ui/ui/progress";

import { ACTION, EverydayFrame, Note, Part, ScreenTitle } from "./frame.tsx";
import { catalogs, type Messages } from "./messages.ts";
import type { ProverArtifactError } from "./prover-artifacts.ts";
import type { MembershipProofProblem } from "./worker/protocol.ts";

// What the voter sees while this device proves they are a member of the
// poll's electorate (P2-21 part 4b-2), and why it stopped when it couldn't.
// The proof is made and checked in the workers (prover-client.ts); nothing
// here decides whether it passed. A still screen: the bar moves only when the
// prover reports a step, never on a timer, and shows no time ([[language]]).

/**
 * Why no proof came back: the ballot worker's refusal, the artifacts'
 * (`unavailable`, or `zkey` and `wasm` refused before the prover started),
 * or `worker-failed` when either worker failed or didn't answer in time.
 */
export type ProvingProblem =
  | MembershipProofProblem
  | ProverArtifactError["problem"]
  | "worker-failed";

/** How many of `of` proving steps are done, as the prover reported them. */
export interface ProvingSteps {
  readonly done: number;
  readonly of: number;
}

/**
 * While the proof is being made. `steps` is the prover's last report, or
 * `undefined` before its first, when the bar shows no value rather than a
 * guess. Nothing to press: the screen leaves when the proof or a refusal comes.
 */
export function Proving({ steps }: { steps: ProvingSteps | undefined }) {
  const t = useTranslate(catalogs);
  const stepsText =
    steps === undefined
      ? t("provingStarting")
      : t("provingSteps", { done: steps.done, of: steps.of });
  return (
    <EverydayFrame>
      <ScreenTitle title={t("provingTitle")} focus>
        <p className="m-0" role="status">
          {t("proving")}
        </p>
      </ScreenTitle>
      <div className="mt-8 border border-border px-4 py-5">
        <Progress
          value={steps?.done ?? null}
          max={steps?.of ?? 1}
          getAriaValueText={() => stepsText}
          // Real progress only, and no motion on the ballot: the bar jumps to each step.
          className="[&_[data-slot=progress-indicator]]:transition-none"
        >
          <ProgressLabel className="text-base font-medium">{t("provingLabel")}</ProgressLabel>
          <span aria-hidden="true" className="ml-auto text-sm text-muted-foreground tabular-nums">
            {stepsText}
          </span>
        </Progress>
      </div>
      <div className="mt-8">
        <Note title={t("provingLocalTitle")}>
          <p className="m-0">{t("provingLocal")}</p>
        </Note>
      </div>
    </EverydayFrame>
  );
}

const REFUSALS: Record<
  ProvingProblem,
  { readonly title: keyof Messages; readonly detail: keyof Messages; readonly retry: boolean }
> = {
  // The voter's own standing: trying again changes nothing.
  secret: { title: "proofSecretTitle", detail: "proofSecret", retry: false },
  "not-a-member": { title: "proofNotMemberTitle", detail: "proofNotMember", retry: false },
  // What a server or the release served: another try fetches it again.
  root: { title: "proofRootTitle", detail: "proofRoot", retry: true },
  unavailable: { title: "proofUnavailableTitle", detail: "proofUnavailable", retry: true },
  // Once the prover holds the witness, every failure is one it may have chosen:
  // a hijacked snarkjs could fail, crash or stall on a bit of the secret, and
  // each retry would offer it another bit, readable from when the ballot is
  // finally sent. So no retry once proving began, only another address
  // (ADR 0009: a refusal shown to the voter, not a retry loop; T-55).
  // `zkey` and `wasm` included: the page's check refuses them before the prover
  // starts, but the prover may also answer with either after the witness.
  zkey: { title: "proofZkeyTitle", detail: "proofZkey", retry: false },
  wasm: { title: "proofWasmTitle", detail: "proofWasm", retry: false },
  prover: { title: "proofProverTitle", detail: "proofProver", retry: false },
  "worker-failed": { title: "proofStoppedTitle", detail: "proofStopped", retry: false },
  proof: { title: "proofWrongTitle", detail: "proofWrong", retry: false },
  rerandomised: { title: "proofFaultTitle", detail: "proofFault", retry: false },
};

/**
 * No proof was made: the check that stopped it in words, its name as the
 * code gives it for whoever the voter reports it to, and a retry only for a
 * refusal made before the prover saw the witness. Nothing was sent either way.
 */
export function ProvingRefused({
  problem,
  onRetry,
}: {
  problem: ProvingProblem;
  onRetry: () => void;
}) {
  const t = useTranslate(catalogs);
  const { title, detail, retry } = REFUSALS[problem];
  return (
    <EverydayFrame
      primary={
        retry ? (
          <Button className={ACTION} onClick={onRetry}>
            {t("tryAgain")}
          </Button>
        ) : undefined
      }
    >
      <ScreenTitle title={t(title)} focus>
        <p className="m-0">{t(detail)}</p>
      </ScreenTitle>
      <Part title={t("proofCheckTitle")}>
        <p className="m-0 text-sm text-muted-foreground">
          {t("proofCheckNamed")}{" "}
          <code translate="no" className="font-mono">
            {problem}
          </code>
        </p>
      </Part>
      <div className="mt-8">
        <Note title={t("nothingSentTitle")}>
          <p className="m-0">{t("proofNothingSent")}</p>
        </Note>
      </div>
    </EverydayFrame>
  );
}
