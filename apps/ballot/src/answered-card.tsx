import { Button, useTranslate } from "@abolishus/ui";
import { Download, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CARD_FONTS, CARD_SIZE, cardFileName, drawCard } from "./answered-card.ts";
import type { Share } from "./ask-others.tsx";
import { ACTION } from "./frame.tsx";
import { catalogs } from "./messages.ts";

/** Whether the browser's share menu takes this file (`navigator.canShare`), which most desktop browsers' don't. */
const canShareFile = (file: File) => {
  try {
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
};

/**
 * The "I answered" card (docs/design/sharing.md, The "I answered" card),
 * drawn on this device when the voter asks for it and shared only by them:
 * through the system's share menu where it takes a picture, or saved as a
 * file. Nothing about it reaches a server, ours included: no request is made
 * to draw, share or save it, so no server learns that it was made, let alone
 * by whom (T-10, T-67). It says the voter answered and never how, carries no
 * tracking code, and proves nothing, since anyone can draw it (T-45, T-46).
 */
export function AnsweredCard({
  share: { url, title },
  seal,
  canShare,
}: {
  share: Share;
  /** The poll's definition hash, drawn as its fingerprint, as the board shows it. */
  seal: string;
  /** Whether the share menu takes the card; detected from the drawn file when left out. */
  canShare?: boolean | undefined;
}) {
  const t = useTranslate(catalogs);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [file, setFile] = useState<File | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const link = url.replace(/^https?:\/\//u, "");
  const lead = t("answeredCardLead");
  const invite = t("answeredCardInvite");
  const check = t("answeredCardCheck");

  useEffect(() => {
    let current = true;
    const draw = async () => {
      const element = canvas.current;
      const ctx = element?.getContext("2d");
      if (element === null || ctx === null || ctx === undefined) throw new Error("no 2D canvas");
      // The self-hosted fonts, so the card isn't drawn in a fallback face;
      // a font that won't load leaves the fallback, which still reads.
      await Promise.all(CARD_FONTS.map((font) => document.fonts.load(font))).catch(() => undefined);
      if (!current) return;
      drawCard(ctx, { lead, question: title, invite, link, check }, seal);
      const blob = await new Promise<Blob | null>((resolve) =>
        element.toBlob(resolve, "image/png"),
      );
      if (blob === null) throw new Error("the canvas gave no picture");
      if (current) setFile(new File([blob], cardFileName(url), { type: "image/png" }));
    };
    setFile(undefined);
    setFailed(false);
    draw().catch(() => {
      if (current) setFailed(true);
    });
    return () => {
      current = false;
    };
  }, [lead, title, invite, link, check, seal, url]);

  const save = () => {
    if (file === undefined) return;
    const href = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = file.name;
    anchor.click();
    // The download has its own copy once started; the URL isn't needed after.
    setTimeout(() => URL.revokeObjectURL(href), 0);
  };
  const menu = file !== undefined && (canShare ?? canShareFile(file));

  return (
    <div className="grid justify-items-start gap-3">
      <canvas
        ref={canvas}
        width={CARD_SIZE}
        height={CARD_SIZE}
        role="img"
        aria-label={t("answeredCardLabel", { question: title, link })}
        className="aspect-square h-auto w-full max-w-80 border border-border"
      />
      <p className="m-0 text-sm text-pretty text-muted-foreground" data-testid="card-note">
        {t("answeredCardNote")}
      </p>
      {failed ? (
        <p role="status" className="m-0 text-sm">
          {t("answeredCardFailed")}
        </p>
      ) : (
        <div className="flex w-full flex-col gap-3 sm:flex-row">
          {menu ? (
            <Button
              size="lg"
              variant="outline"
              className={ACTION}
              // The picture, the question and the link; a dismissed menu rejects.
              onClick={() =>
                void navigator.share({ files: [file], title, url }).catch(() => undefined)
              }
            >
              <Share2 aria-hidden="true" />
              {t("answeredCardShare")}
            </Button>
          ) : null}
          <Button
            size="lg"
            variant="outline"
            className={ACTION}
            disabled={file === undefined}
            onClick={save}
          >
            <Download aria-hidden="true" />
            {t("answeredCardSave")}
          </Button>
        </div>
      )}
    </div>
  );
}
