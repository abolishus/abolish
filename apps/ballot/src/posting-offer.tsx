import { Button, Fingerprint, groupHex, Hash, useTranslate } from "@abolishus/ui";

import { ACTION, EverydayFrame, type FramePoll, Note, Part, ScreenTitle } from "./frame.tsx";
import { catalogs } from "./messages.ts";

// The voter's choice for a cast ballot some of whose trustees never took
// their sealed part ([[delivery]], Client rule 4): try the trustees again,
// post the missing parts publicly, which lowers those parts' long-term
// privacy, or leave the ballot, which erases what this device kept for them.
// Posting is never the default: it is offered only once the client has said
// what it costs, and it sits beside the other choices, never above them (T-15).

const shortHex = (hash: string) => groupHex(hash).slice(0, 2).join(" ");

/**
 * The offer, asked as soon as delivery failed so a voter who leaves the
 * ballot can still answer again while the poll is open. `onPost` is absent
 * in a build that has no contract path to post through; `failed` says a
 * posting the voter chose didn't go through.
 */
export function PostingOffer({
  poll,
  trackingCode,
  missing,
  failed = false,
  onRetry,
  onDecline,
  onPost,
}: {
  poll: FramePoll;
  trackingCode: string;
  /** How many of the poll's trustees haven't taken their part. */
  missing: number;
  failed?: boolean;
  onRetry: () => void;
  onDecline: () => void;
  onPost?: (() => void) | undefined;
}) {
  const t = useTranslate(catalogs);
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
      {failed ? (
        <div className="mt-6">
          <Note tone="warn" title={t("postingFailedTitle")}>
            <p className="m-0">{t("postingFailed")}</p>
          </Note>
        </div>
      ) : null}
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
          <div>
            <Button size="lg" variant="outline" className={ACTION} onClick={onPost}>
              {t("postingPost")}
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
