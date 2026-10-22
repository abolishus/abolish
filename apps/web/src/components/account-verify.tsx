import { Button, buttonVariants, cn, useI18n, useTranslate } from "@abolishus/ui";
import { Input } from "@abolishus/ui/ui/input";
import { Label } from "@abolishus/ui/ui/label";
import { CircleCheck, CircleDashed } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import type { Challenge } from "../account/challenge.ts";
import { VerifyError, type VerifyClient, type VerifyFailure } from "../account/verify.ts";
import { catalogs } from "../messages.ts";
import { formatUtc, formatUtcDay } from "./format.ts";
import { PageHeader, Section } from "./page-parts.tsx";

type Kind = "email" | "phone";

const FIELD = "min-h-12 px-3 text-base md:text-base";

/** What the server holds for one step, in words the page shows. */
type Held =
  | { readonly kind: "loading" }
  | { readonly kind: "none" }
  /** `address` is e-mail's only: the number is never kept. */
  | { readonly kind: "verified"; readonly address?: string; readonly date: string }
  | { readonly kind: "unavailable" }
  | { readonly kind: "signedOut" }
  | { readonly kind: "unread" };

/** Where the step is: entering the address or number, the check, or the code. */
type Stage =
  | { readonly kind: "shown" }
  | { readonly kind: "entering" }
  | { readonly kind: "checking" }
  | { readonly kind: "sending" }
  /** A code went to `target`, held here only while it waits (the number is never stored). */
  | { readonly kind: "code"; readonly target: string };

type Failure =
  | { readonly failure: VerifyFailure; readonly triesLeft?: number | undefined }
  | { readonly failure: "noTarget" | "noCodeTyped" };

/** Refusals after which the waiting code is no use: the step starts over. */
const RESTARTS: ReadonlySet<VerifyFailure> = new Set([
  "noCode",
  "expired",
  "tooManyTries",
  "addressTaken",
  "numberHeld",
]);

/** Refusals about what was typed in the address or number's field, which it marks invalid. */
const TARGET_FAILURES: ReadonlySet<Failure["failure"]> = new Set([
  "noTarget",
  "invalidAddress",
  "invalidNumber",
  "unsupportedCountry",
  "virtualNumber",
]);

/** Refusals about the code typed. */
const CODE_FAILURES: ReadonlySet<Failure["failure"]> = new Set(["noCodeTyped", "wrongCode"]);

/** What a refusal means for what the server holds. */
const heldAfter = (failure: VerifyFailure): Held | undefined =>
  failure === "signedOut"
    ? { kind: "signedOut" }
    : failure === "unavailable"
      ? { kind: "unavailable" }
      : undefined;

/** Reads what the server holds for `kind`, as the page shows it. */
async function readHeld(client: VerifyClient, kind: Kind, locale: string): Promise<Held> {
  try {
    if (kind === "email") {
      const email = await client.email();
      return email === undefined
        ? { kind: "none" }
        : {
            kind: "verified",
            address: email.address,
            date: formatUtc(locale, new Date(email.verifiedAt)),
          };
    }
    const phone = await client.phone();
    return phone === undefined
      ? { kind: "none" }
      : { kind: "verified", date: formatUtcDay(locale, phone.verifiedOn) };
  } catch (e) {
    return (e instanceof VerifyError && heldAfter(e.failure)) || { kind: "unread" };
  }
}

/** What the server holds for `kind`, read unless `read` is false. */
function useHeld(client: VerifyClient, kind: Kind, read = true) {
  const { locale } = useI18n();
  const [held, setHeld] = useState<Held>({ kind: "loading" });
  const refresh = useCallback(
    async () => setHeld(await readHeld(client, kind, locale)),
    [client, kind, locale],
  );
  useEffect(() => {
    if (read) void refresh();
  }, [refresh, read]);
  return [held, setHeld, refresh] as const;
}

function Step({
  kind,
  index,
  client,
  challenge,
}: {
  kind: Kind;
  index: string;
  client: VerifyClient;
  challenge: Challenge | undefined;
}) {
  const t = useTranslate(catalogs);
  const [held, setHeld, refresh] = useHeld(client, kind);
  const [stage, setStage] = useState<Stage>({ kind: "shown" });
  const [target, setTarget] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [checked, setChecked] = useState(false);
  // Actions replace the controls that had focus: focus goes back to the
  // step's heading, so keyboard users keep their place.
  const heading = useRef<HTMLHeadingElement>(null);
  // Where Turnstile renders its frame, and the way to take it down again.
  const checkBox = useRef<HTMLDivElement>(null);
  const solving = useRef<AbortController | undefined>(undefined);

  // A check under way when the page goes is taken down with it.
  useEffect(() => () => solving.current?.abort(), []);

  const refused = (e: unknown) => {
    const why = e instanceof VerifyError ? e.failure : "failed";
    const after = heldAfter(why);
    if (after !== undefined) {
      setHeld(after);
      setStage({ kind: "shown" });
    }
    setFailure({
      failure: why,
      triesLeft: e instanceof VerifyError ? e.triesLeft : undefined,
    });
    return why;
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setFailure(undefined);
    setChecked(false);
    const typed = target.trim();
    if (typed === "") return setFailure({ failure: "noTarget" });
    if (challenge === undefined) return setFailure({ failure: "unavailable" });
    const container = checkBox.current;
    if (container === null) return;
    const controller = new AbortController();
    solving.current = controller;
    setBusy(true);
    setStage({ kind: "checking" });
    let token: string;
    try {
      token = await challenge.solve(
        container,
        kind === "email" ? "email-code" : "phone-code",
        controller.signal,
      );
    } catch {
      if (controller.signal.aborted) return;
      setStage({ kind: "entering" });
      setFailure({ failure: "challengeUnavailable" });
      setBusy(false);
      return;
    } finally {
      if (solving.current === controller) solving.current = undefined;
    }
    setStage({ kind: "sending" });
    try {
      if (kind === "email") await client.requestEmailCode(typed, token);
      else await client.requestPhoneCode(typed, token);
      setCode("");
      setStage({ kind: "code", target: typed });
    } catch (e) {
      // The token is spent either way: sending again takes a new check.
      refused(e);
      setStage({ kind: "entering" });
    } finally {
      setBusy(false);
      heading.current?.focus();
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || stage.kind !== "code") return;
    setFailure(undefined);
    const typed = code.trim();
    if (typed === "") return setFailure({ failure: "noCodeTyped" });
    setBusy(true);
    try {
      if (kind === "email") await client.verifyEmailCode(typed);
      else await client.verifyPhoneCode(stage.target, typed);
      // The number goes from the page too, now that nothing waits on it.
      setTarget("");
      setCode("");
      setStage({ kind: "shown" });
      setChecked(true);
      await refresh();
    } catch (e) {
      const why = refused(e);
      if (RESTARTS.has(why)) setStage({ kind: "entering" });
    } finally {
      setBusy(false);
      heading.current?.focus();
    }
  };

  const change = () => {
    setChecked(false);
    setFailure(undefined);
    setStage({ kind: "entering" });
  };

  const cancel = () => {
    setFailure(undefined);
    setTarget("");
    setStage({ kind: "shown" });
    heading.current?.focus();
  };

  const startOver = () => {
    setChecked(false);
    setFailure(undefined);
    setCode("");
    setStage({ kind: "entering" });
    heading.current?.focus();
  };

  const targetInvalid = failure !== undefined && TARGET_FAILURES.has(failure.failure);
  const codeInvalid = failure !== undefined && CODE_FAILURES.has(failure.failure);
  const fieldId = `verify-${kind}`;
  const codeId = `verify-${kind}-code`;
  const failureId = `verify-${kind}-failure`;
  const canVerify = held.kind === "none" || held.kind === "verified";
  const entering =
    canVerify &&
    (stage.kind === "entering" ||
      stage.kind === "checking" ||
      stage.kind === "sending" ||
      (stage.kind === "shown" && held.kind === "none"));

  const failureText =
    failure === undefined
      ? undefined
      : failure.failure === "noTarget"
        ? t(`verifyNoTarget_${kind}`)
        : failure.failure === "noCodeTyped"
          ? t("verifyNoCode")
          : failure.failure === "wrongCode" && failure.triesLeft !== undefined
            ? t("verifyFailure_wrongCodeTries", { count: failure.triesLeft })
            : t(`verifyFailure_${failure.failure}`);

  return (
    <Section
      index={index}
      mark={t(`verifyMark_${kind}`)}
      title={t(`verifyHeading_${kind}`)}
      id={`verify-${kind}-title`}
      titleRef={heading}
      lede={<p className="m-0">{t(`verifyLede_${kind}`)}</p>}
    >
      <div className="grid max-w-prose gap-6">
        <p className="m-0 flex items-start gap-2 text-base" suppressHydrationWarning>
          {held.kind === "verified" ? (
            <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-recorded" />
          ) : held.kind === "none" ? (
            <CircleDashed aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          ) : null}
          <span>
            {held.kind === "loading"
              ? t("verifyLoading")
              : held.kind === "none"
                ? t(`verifyNone_${kind}`)
                : held.kind === "verified"
                  ? kind === "email"
                    ? t("verifyVerified_email", { address: held.address ?? "", date: held.date })
                    : t("verifyVerified_phone", { date: held.date })
                  : held.kind === "unavailable"
                    ? t("verifyFailure_unavailable")
                    : held.kind === "signedOut"
                      ? t("verifyFailure_signedOut")
                      : t("verifyFailure_failed")}
          </span>
        </p>

        {held.kind === "verified" && stage.kind === "shown" ? (
          <div>
            <Button variant="outline" onClick={change}>
              {t(`verifyChange_${kind}`)}
            </Button>
          </div>
        ) : null}

        {entering ? (
          <form noValidate onSubmit={(e) => void send(e)} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor={fieldId} className="text-base font-semibold">
                {t(`verifyLabel_${kind}`)}
              </Label>
              <p id={`${fieldId}-help`} className="m-0 text-sm text-muted-foreground">
                {t(`verifyHelp_${kind}`)}
              </p>
              <Input
                id={fieldId}
                className={FIELD}
                {...(kind === "email"
                  ? { type: "email", autoComplete: "email", inputMode: "email" }
                  : { type: "tel", autoComplete: "tel", inputMode: "tel" })}
                spellCheck={false}
                aria-describedby={
                  failure === undefined ? `${fieldId}-help` : `${fieldId}-help ${failureId}`
                }
                aria-invalid={targetInvalid ? true : undefined}
                disabled={busy}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="lg" disabled={busy}>
                {t("verifySend")}
              </Button>
              {held.kind === "verified" ? (
                <Button type="button" size="lg" variant="outline" disabled={busy} onClick={cancel}>
                  {t("verifyCancel")}
                </Button>
              ) : null}
            </div>
            <p className="m-0 text-sm text-muted-foreground">{t("verifyCloudflare")}</p>
          </form>
        ) : null}

        {/* Turnstile renders its frame here (src/account/challenge.ts). */}
        <div
          ref={checkBox}
          role="group"
          aria-label={t("verifyCheckLabel")}
          hidden={stage.kind !== "checking"}
        />

        {canVerify && stage.kind === "code" ? (
          <form noValidate onSubmit={(e) => void verify(e)} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor={codeId} className="text-base font-semibold">
                {t("verifyCodeLabel")}
              </Label>
              <Input
                id={codeId}
                className={cn(FIELD, "w-48 font-mono tracking-widest tabular-nums")}
                inputMode="numeric"
                autoComplete="one-time-code"
                spellCheck={false}
                aria-describedby={failure === undefined ? undefined : failureId}
                aria-invalid={codeInvalid ? true : undefined}
                disabled={busy}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="lg" disabled={busy}>
                {t("verifyCodeSubmit")}
              </Button>
              <Button type="button" size="lg" variant="outline" disabled={busy} onClick={startOver}>
                {t("verifyStartOver")}
              </Button>
            </div>
          </form>
        ) : null}

        <div role="status" className="min-h-6 text-base">
          {stage.kind === "checking"
            ? t("verifyChecking")
            : stage.kind === "sending"
              ? t("verifySending")
              : stage.kind === "code"
                ? kind === "email"
                  ? t("verifySent_email", { address: stage.target })
                  : t("verifySent_phone", { number: stage.target })
                : checked
                  ? t(`verifyChecked_${kind}`)
                  : null}
        </div>
        {failureText === undefined ? null : (
          <p id={failureId} role="alert" className="m-0 text-destructive">
            {failureText}
          </p>
        )}
      </div>
    </Section>
  );
}

export interface VerifyPageProps {
  readonly client: VerifyClient;
  /** Turnstile, if this deployment has a site key; without one no code can be asked for. */
  readonly challenge?: Challenge | undefined;
  /** Whether this deployment verifies a phone before an account votes; without it the page asks for none. */
  readonly phone: boolean;
}

/**
 * Verifying the account's e-mail address, and its phone number where this
 * deployment turns phone verification on ([[0038-verified-accounts]]; P2-31
 * parts 4 and 6a): each by a code sent to it, after a Turnstile check
 * (T-52). Nothing here touches a ballot or a voting identity (T-10); the
 * number is held only while its code waits, since the server never keeps it
 * (T-73).
 */
export function VerifyPage({ client, challenge, phone }: VerifyPageProps) {
  const t = useTranslate(catalogs);
  const scope = phone ? "phone" : "email";
  return (
    <div className="grid gap-16">
      <PageHeader
        eyebrow={t("verifyEyebrow")}
        title={t(`verifyPageTitle_${scope}`)}
        lede={t(`verifyPageLede_${scope}`)}
      >
        <p className="m-0">
          <a href="/account" className="underline underline-offset-4">
            {t("verifyBack")}
          </a>
        </p>
        <noscript>
          <p className="m-0 text-lg">{t("verifyNeedsScript")}</p>
        </noscript>
      </PageHeader>
      <Step kind="email" index="01" client={client} challenge={challenge} />
      {phone ? <Step kind="phone" index="02" client={client} challenge={challenge} /> : null}
    </div>
  );
}

export interface AccountVerificationProps {
  readonly client: VerifyClient;
  /** The section's number on the page. */
  readonly index: string;
  /** Whether this deployment verifies a phone before an account votes. */
  readonly phone: boolean;
}

/**
 * The account page's view of its verification: what is verified, and the
 * way to the page that verifies it (`/account/verify`, the only account
 * page besides the editor whose policy allows Turnstile). The phone is asked
 * for when the account first votes, never at sign-up ([[0038-verified-accounts]],
 * Owner decision (2026-10-22)), so only the e-mail is pressed for here: a
 * missing number reads as asked for later, and the way to verify it early
 * stays.
 */
export function AccountVerification({ client, index, phone: phoneOn }: AccountVerificationProps) {
  const t = useTranslate(catalogs);
  const scope = phoneOn ? "phone" : "email";
  const [email] = useHeld(client, "email");
  const [phone] = useHeld(client, "phone", phoneOn);
  const row = (label: string, held: Held, done: string, none: string) => (
    <li className="grid gap-1 border-b border-border py-4 md:grid-cols-[12rem_minmax(0,1fr)]">
      <span className="font-semibold">{label}</span>
      <span className="flex items-start gap-2 break-words" suppressHydrationWarning>
        {held.kind === "verified" ? (
          <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-recorded" />
        ) : held.kind === "none" ? (
          <CircleDashed aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
        ) : null}
        <span className="min-w-0">
          {held.kind === "loading"
            ? t("verifyLoading")
            : held.kind === "verified"
              ? done
              : held.kind === "none"
                ? none
                : held.kind === "unavailable"
                  ? t("verificationUnavailable")
                  : t("verificationUnread")}
        </span>
      </span>
    </li>
  );
  const complete = email.kind === "verified";
  return (
    <Section
      index={index}
      mark={t("verificationMark")}
      title={t(`verificationTitle_${scope}`)}
      id="verification-title"
      lede={<p className="m-0">{t(`verificationLede_${scope}`)}</p>}
    >
      <ul className="m-0 grid list-none border-t-2 border-foreground p-0">
        {row(
          t("verificationEmail"),
          email,
          email.kind === "verified"
            ? t("verificationEmailDone", { address: email.address ?? "" })
            : "",
          t("verificationNotYet"),
        )}
        {phoneOn
          ? row(
              t("verificationPhone"),
              phone,
              phone.kind === "verified" ? t("verificationPhoneDone", { date: phone.date }) : "",
              t("verificationPhoneLater"),
            )
          : null}
      </ul>
      <div>
        <a
          href="/account/verify"
          className={buttonVariants({ variant: complete ? "outline" : "default", size: "lg" })}
        >
          {t(complete ? `verificationManage_${scope}` : "verificationGo")}
        </a>
      </div>
    </Section>
  );
}
