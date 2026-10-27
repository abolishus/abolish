import { Button, Fingerprint, groupHex, Hash, useTranslate } from "@abolishus/ui";

import { ACTION, EverydayFrame, type FramePoll, Note, Part, ScreenTitle } from "./frame.tsx";
import { catalogs, type Messages } from "./messages.ts";
import type { WalletAnswer } from "./wallet.ts";

// The voter's choice for a cast ballot some of whose trustees never took
// their sealed part ([[delivery]], Client rule 4): try the trustees again,
// post the missing parts publicly, which lowers those parts' long-term
// privacy, or leave the ballot, which erases what this device kept for them.
// Posting is never the default: it is offered only once the client has said
// what it costs, and it sits beside the other choices, never above them (T-15).

const shortHex = (hash: string) => groupHex(hash).slice(0, 2).join(" ");

// What the voter's own wallet met, as the offer says it. A run that may have
// handed the wallet the parts says so, and so does every later offer, never
// "nothing posted" (`handed`; T-15).
const WALLET_NOTES = {
  forced: { title: "walletForcedTitle", detail: "walletForced" },
  sent: { title: "walletSentTitle", detail: "walletSent" },
  rejected: { title: "walletRejectedTitle", detail: "walletRejected" },
  refused: { title: "walletRefusedTitle", detail: "walletRefused" },
  "wrong-chain": { title: "walletWrongChainTitle", detail: "walletWrongChain" },
  "no-wallet": { title: "walletMissingTitle", detail: "walletMissing" },
  late: { title: "walletLateTitle", detail: "walletLate" },
  failed: { title: "walletFailedTitle", detail: "walletFailed" },
} as const satisfies Record<
  Exclude<WalletAnswer, "recorded">,
  { readonly title: keyof Messages; readonly detail: keyof Messages }
>;

// The wallet's notes that themselves say the parts may still reach the board.
const SAYS_GIVEN: ReadonlySet<WalletAnswer> = new Set(["forced", "sent"]);

/**
 * The offer, asked as soon as delivery failed so a voter who leaves the
 * ballot can still answer again while the poll is open. `onPost` is absent
 * in a build that has no contract path to post through; `failed` says a
 * posting the voter chose didn't go through, and `relayed` that it didn't
 * after the relay had the parts, which may then still reach the board, so
 * the voter is never told nothing was posted ([[posting-relay]], Outcome;
 * T-15). `onWallet` is present only once a run through the relay fell
 * back, and offers the voter's own wallet with what it costs: the paying
 * address is published beside the ballot ([[0042-posting-relay]], rule 6;
 * T-13); `wallet` is what that wallet last met. `late` says the relay's
 * send cutoff passed, so a run through it is a late one, best effort,
 * which the offer says before it can be chosen ([[posting-relay]], The
 * ballot's own deadline; T-15, T-25), and `lateWallet` the same of the
 * wallet once its send may no longer be forced through Ethereum in time.
 */
export function PostingOffer({
  poll,
  trackingCode,
  missing,
  failed = false,
  relayed = false,
  onRetry,
  onDecline,
  handed = false,
  onPost,
  onWallet,
  wallet,
  late = false,
  lateWallet = false,
}: {
  poll: FramePoll;
  trackingCode: string;
  /** How many of the poll's trustees haven't taken their part. */
  missing: number;
  failed?: boolean;
  relayed?: boolean;
  /** An earlier run may have handed the parts out, whatever the latest one met. */
  handed?: boolean;
  onRetry: () => void;
  onDecline: () => void;
  onPost?: (() => void) | undefined;
  onWallet?: (() => void) | undefined;
  wallet?: Exclude<WalletAnswer, "recorded"> | undefined;
  late?: boolean;
  lateWallet?: boolean;
}) {
  const t = useTranslate(catalogs);
  const walletNote = wallet === undefined ? undefined : WALLET_NOTES[wallet];
  // The relay's note, or the wallet's that already says the parts were
  // given, covers what an earlier run handed out; any other gets this one.
  const handedNote = handed && !relayed && (wallet === undefined || !SAYS_GIVEN.has(wallet));
  return (
    <EverydayFrame
      poll={poll}
      primary={
        <Button size="lg" className={ACTION} onClick={onRetry}>
          {t("postingRetry")}
        </Button>
      }
      secondary={
        <Button size="lg" variant="outline" className={ACTION} onClick={onDecline}>
          {t("postingDecline")}
        </Button>
      }
    >
      <ScreenTitle title={t("postingOfferTitle")} focus>
        <p className="m-0">{t("postingOffer", { count: missing })}</p>
      </ScreenTitle>
      {failed && (relayed || (walletNote === undefined && !handed)) ? (
        <div className="mt-6">
          <Note tone="warn" title={t(relayed ? "postingRelayedTitle" : "postingFailedTitle")}>
            <p className="m-0">{t(relayed ? "postingRelayed" : "postingFailed")}</p>
          </Note>
        </div>
      ) : null}
      {handedNote ? (
        <div className="mt-6">
          <Note tone="warn" title={t("postingHandedTitle")}>
            <p className="m-0">{t("postingHanded")}</p>
          </Note>
        </div>
      ) : null}
      {walletNote === undefined ? null : (
        <div className="mt-6">
          <Note tone="warn" title={t(walletNote.title)}>
            <p className="m-0">{t(walletNote.detail)}</p>
          </Note>
        </div>
      )}
      <div className="mt-8 grid gap-4 border-2 border-foreground px-4 py-5">
        <Fingerprint
          value={trackingCode}
          label={t("trackingCodeFingerprint", { hash: shortHex(trackingCode) })}
          size={56}
        />
        <Hash value={trackingCode} label={t("trackingCodeLabel")} />
      </div>
      <Part title={t("postingRetryTitle")}>
        <p className="m-0">{t("postingRetryExplained")}</p>
      </Part>
      {onPost === undefined ? null : (
        <Part title={t("postingPostTitle")}>
          <p className="m-0">{t("postingPostExplained")}</p>
          {late ? (
            <Note tone="warn" title={t("postingLateTitle")}>
              <p className="m-0">{t("postingLate")}</p>
            </Note>
          ) : null}
          <div>
            <Button size="lg" variant="outline" className={ACTION} onClick={onPost}>
              {t("postingPost")}
            </Button>
          </div>
        </Part>
      )}
      {onWallet === undefined ? null : (
        <Part title={t("postingWalletOfferTitle")}>
          <p className="m-0">{t("postingWalletOffer")}</p>
          {lateWallet ? (
            <Note tone="warn" title={t("postingLateTitle")}>
              <p className="m-0">{t("postingWalletLate")}</p>
            </Note>
          ) : null}
          <div>
            <Button size="lg" variant="outline" className={ACTION} onClick={onWallet}>
              {t("postingWalletPost")}
            </Button>
          </div>
        </Part>
      )}
      <Part title={t("postingDeclineTitle")}>
        <p className="m-0">{t("postingDeclineExplained")}</p>
      </Part>
    </EverydayFrame>
  );
}

/**
 * The voter left a ballot rather than post its missing parts: this device
 * erased them, and the ballot won't count. Answering again casts one that
 * replaces it wherever the declined one reaches the board.
 */
export function Declined({ poll, onAgain }: { poll: FramePoll; onAgain: () => void }) {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame
      poll={poll}
      primary={
        <Button size="lg" className={ACTION} onClick={onAgain}>
          {t("answerAgain")}
        </Button>
      }
    >
      <ScreenTitle title={t("declinedTitle")} focus>
        <p className="m-0">{t("declined")}</p>
      </ScreenTitle>
    </EverydayFrame>
  );
}
