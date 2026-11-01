import { Count, Fingerprint, Hash, useTranslate } from "@abolishus/ui";

import { catalogs } from "../messages.ts";
import type { BoardHead } from "../server/load.ts";

/**
 * A board's head as our server claims it: its size, its chain head with
 * that head's fingerprint and what the head commits to, its tree root, and that these are only the
 * server's word until a checkpoint on L1 covers them (T-23, T-24). One
 * component, so the poll page and the results page can't state one board
 * differently (T-34).
 */
export function BoardHeadFacts({ head }: { head: BoardHead }) {
  const t = useTranslate(catalogs);
  if (head.treeSize === "0") return <p className="m-0">{t("boardEmpty")}</p>;
  return (
    <>
      <p className="m-0">
        {t("boardEntries")}: <Count value={BigInt(head.treeSize)} />
      </p>
      <div className="flex min-w-0 items-start gap-4">
        <Fingerprint
          value={head.chainHead}
          label={t("fingerprintHead", { prefix: head.chainHead.slice(0, 8) })}
          size={56}
        />
        <div className="min-w-0">
          <Hash value={head.chainHead} label={t("boardHead")} />
        </div>
      </div>
      <p className="m-0 max-w-prose text-muted-foreground">
        {t("boardHeadMeaning", { count: BigInt(head.treeSize) })}
      </p>
      <Hash value={head.root} label={t("boardRoot")} />
      <p className="m-0 max-w-prose text-muted-foreground">{t("boardUnanchored")}</p>
    </>
  );
}
