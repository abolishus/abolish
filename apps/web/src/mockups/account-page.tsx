import { Button, Count, SectionMark, cn } from "@abolishus/ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@abolishus/ui/ui/alert-dialog";
import { Input } from "@abolishus/ui/ui/input";
import { Label } from "@abolishus/ui/ui/label";
import { Switch } from "@abolishus/ui/ui/switch";
import { KeyRound, Laptop, Server, Smartphone, UserPlus } from "lucide-react";
import { type ReactNode, useState } from "react";

import { COUNCIL, LEVY, PARKS, TRANSIT } from "./fixtures.ts";
import { Frame, MockShell, PageHead } from "./shell.tsx";

function SectionHead({
  index,
  mark,
  id,
  title,
}: {
  index: string;
  mark: string;
  id: string;
  title: string;
}) {
  return (
    <div className="grid gap-4">
      <SectionMark index={index}>{mark}</SectionMark>
      <h2
        id={id}
        className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight sm:text-4xl"
      >
        {title}
      </h2>
    </div>
  );
}

function Separation() {
  const side = (
    icon: ReactNode,
    where: string,
    title: string,
    items: readonly string[],
    note: string,
  ) => (
    <div className="grid content-start gap-4 py-6 md:px-8 md:first:ps-0 md:last:pe-0">
      <p className="m-0 flex items-center gap-2 font-mono text-xs tracking-widest uppercase">
        <span aria-hidden="true">{icon}</span>
        {where}
      </p>
      <h3 className="m-0 font-heading text-2xl font-semibold">{title}</h3>
      <ul className="m-0 grid list-none gap-0 border-t border-foreground p-0">
        {items.map((i) => (
          <li key={i} className="border-b border-border py-3 text-base">
            {i}
          </li>
        ))}
      </ul>
      <p className="m-0 text-sm text-muted-foreground">{note}</p>
    </div>
  );
  return (
    <div className="relative grid border-t-2 border-foreground md:grid-cols-[1fr_auto_1fr]">
      {side(
        <Server className="size-4" />,
        "On our servers",
        "Your account",
        ["A passkey’s public key", "Polls you created and drafts", "Notification settings"],
        "Who you are to this website. It can create and follow polls. It can’t vote.",
      )}
      <div className="flex items-center gap-3 border-y border-border py-3 md:flex-col md:justify-center md:border-y-0 md:border-x md:px-3 md:py-0">
        <span aria-hidden="true" className="h-px flex-1 bg-foreground md:h-auto md:w-px" />
        <span className="font-mono text-xs tracking-widest uppercase md:[writing-mode:vertical-rl]">
          Never joined
        </span>
        <span aria-hidden="true" className="h-px flex-1 bg-foreground md:h-auto md:w-px" />
      </div>
      {side(
        <Smartphone className="size-4" />,
        "On your device only",
        "Your voting identity",
        [
          "A secret that proves you may vote, without saying who you are",
          "Your ballot receipts",
          "A backup, encrypted with your passkey, for a new device",
        ],
        "It never leaves your device unencrypted, and we never see it.",
      )}
    </div>
  );
}

export function SignedOutPage() {
  const [waiting, setWaiting] = useState<"signin" | "create" | undefined>();
  return (
    <MockShell current="/account">
      <PageHead
        eyebrow="Account"
        title="Sign in, or create an account"
        lede="An account lets you create polls, follow them and hear about decisions that affect them. You don’t need one to vote, and it never casts a vote."
      />
      <Frame className="grid gap-16">
        <div className="grid border-t-2 border-foreground md:grid-cols-2">
          <div className="grid content-start gap-4 border-b border-border py-8 md:border-e md:border-b-0 md:pe-8">
            <h2 className="m-0 text-2xl font-semibold">I have an account</h2>
            <p className="m-0 max-w-prose text-base">
              Your device will ask for your fingerprint, face or screen lock. There is no password.
            </p>
            <div>
              <Button size="lg" onClick={() => setWaiting("signin")}>
                <KeyRound aria-hidden="true" data-icon="inline-start" />
                Sign in with a passkey
              </Button>
            </div>
          </div>
          <div className="grid content-start gap-4 py-8 md:ps-8">
            <h2 className="m-0 text-2xl font-semibold">I’m new here</h2>
            <p className="m-0 max-w-prose text-base">
              We create a passkey on this device and keep only its public key. No name or email is
              needed.
            </p>
            <div>
              <Button size="lg" variant="outline" onClick={() => setWaiting("create")}>
                <UserPlus aria-hidden="true" data-icon="inline-start" />
                Create an account
              </Button>
            </div>
          </div>
        </div>
        <p role="status" className="m-0 min-h-6 text-base">
          {waiting === undefined
            ? null
            : waiting === "signin"
              ? "Waiting for your passkey. Follow the prompt from your device."
              : "Creating a passkey. Follow the prompt from your device."}
        </p>

        <section aria-labelledby="separate-title" className="grid gap-8">
          <SectionHead
            index="01"
            mark="Accounts and votes"
            id="separate-title"
            title="Your account is not your vote"
          />
          <p className="m-0 max-w-prose text-lg text-pretty">
            The two are kept apart by design. Nothing on our servers, in any table, log or request,
            links an account to a ballot. A test in the code checks it on every change.
          </p>
          <Separation />
        </section>
      </Frame>
    </MockShell>
  );
}

const MY_POLLS = [
  {
    title: PARKS.title,
    status: PARKS.status,
    when: `Closes ${PARKS.closes}`,
    entries: PARKS.entries,
  },
  { title: TRANSIT.title, status: TRANSIT.status, when: `Opens ${TRANSIT.opens}`, entries: 0 },
  {
    title: COUNCIL.title,
    status: COUNCIL.status,
    when: `Closed ${COUNCIL.closes}`,
    entries: COUNCIL.entries,
  },
  { title: LEVY.title, status: LEVY.status, when: `Counted ${LEVY.closes}`, entries: LEVY.entries },
  {
    title: "Harbor library Sunday hours",
    status: "Draft",
    when: "Last edited 11 October 2026",
    entries: 0,
  },
] as const;

const STATUS_STYLE: Record<string, string> = {
  Open: "bg-pending",
  Counted: "bg-recorded",
  Closed: "bg-foreground",
  Scheduled: "border border-foreground",
  Draft: "border border-dashed border-foreground",
};

const NOTICES = [
  {
    id: "n-opens",
    label: "A poll I created opens",
    help: "One notice when voting starts.",
    on: true,
  },
  {
    id: "n-counted",
    label: "A poll I created is counted",
    help: "When the trustees publish the totals.",
    on: true,
  },
  {
    id: "n-digest",
    label: "A weekly list of new polls",
    help: "Sent on Mondays. Only polls that are listed.",
    on: false,
  },
] as const;

const PASSKEYS = [
  {
    name: "iCloud Keychain",
    kind: "Synced across your Apple devices",
    created: "2 October 2026",
    used: "Today, 09:12 UTC",
    icon: <Smartphone className="size-5" />,
  },
  {
    name: "Security key",
    kind: "This device only",
    created: "4 October 2026",
    used: "6 October 2026",
    icon: <KeyRound className="size-5" />,
  },
  {
    name: "Windows Hello",
    kind: "This device only",
    created: "9 October 2026",
    used: "9 October 2026",
    icon: <Laptop className="size-5" />,
  },
] as const;

export function SignedInPage() {
  const [notices, setNotices] = useState<Record<string, boolean>>(
    Object.fromEntries(NOTICES.map((n) => [n.id, n.on])),
  );
  const [passkeys, setPasskeys] = useState<readonly (typeof PASSKEYS)[number][]>(PASSKEYS);
  return (
    <MockShell current="/account" signedIn>
      <PageHead
        eyebrow="Account · Signed in with a passkey"
        title="Your account"
        lede="Polls you created, the notices you get about them, and the passkeys that sign you in. Your votes are not here: they live on your device."
      >
        <div>
          <Button variant="outline">Sign out</Button>
        </div>
      </PageHead>

      <Frame className="grid gap-20">
        <section aria-labelledby="polls-title" className="grid gap-8">
          <SectionHead index="01" mark="Your polls" id="polls-title" title="Polls you created" />
          <ul className="m-0 grid list-none border-t-2 border-foreground p-0">
            {MY_POLLS.map((p) => (
              <li
                key={p.title}
                className="grid gap-x-6 gap-y-2 border-b border-border py-5 md:grid-cols-[minmax(0,1fr)_8rem_minmax(0,16rem)_7rem] md:items-center"
              >
                <h3 className="m-0 text-lg leading-snug font-semibold">
                  <a href="/polls" className="underline-offset-4 hover:underline">
                    {p.title}
                  </a>
                </h3>
                <p className="m-0 flex items-center gap-2 text-sm">
                  <span
                    aria-hidden="true"
                    className={cn("inline-block size-2.5 shrink-0", STATUS_STYLE[p.status])}
                  />
                  {p.status}
                </p>
                <p className="m-0 font-mono text-xs tracking-wide">{p.when}</p>
                <p className="m-0 text-sm md:text-end">
                  {p.status === "Draft" ? (
                    <a href="/polls/new" className="underline underline-offset-4">
                      Continue draft
                    </a>
                  ) : (
                    <>
                      <Count value={p.entries} /> entries
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="notices-title" className="grid gap-8 lg:grid-cols-12">
          <div className="lg:col-span-12">
            <SectionHead
              index="02"
              mark="Notifications"
              id="notices-title"
              title="What we tell you about"
            />
          </div>
          <form
            className="grid content-start gap-0 lg:col-span-7"
            onSubmit={(e) => e.preventDefault()}
          >
            <ul className="m-0 grid list-none border-t-2 border-foreground p-0">
              {NOTICES.map((n) => (
                <li key={n.id} className="border-b border-border">
                  <Label className="flex min-h-12 w-full items-center justify-between gap-6 py-4 text-base font-normal">
                    <span className="grid gap-0.5">
                      <span className="font-semibold">{n.label}</span>
                      <span className="text-sm text-muted-foreground">{n.help}</span>
                    </span>
                    <Switch
                      checked={notices[n.id] ?? false}
                      onCheckedChange={(checked) => setNotices({ ...notices, [n.id]: checked })}
                    />
                  </Label>
                </li>
              ))}
              <li className="grid gap-0.5 border-b border-border py-4">
                <span className="font-semibold">A moderation decision on a poll I created</span>
                <span className="text-sm text-muted-foreground">
                  Always sent, so that you can appeal. It can’t be turned off.
                </span>
              </li>
            </ul>
            <div className="grid gap-2 pt-8">
              <Label htmlFor="notice-email" className="text-base font-semibold">
                Email for notices{" "}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <p id="notice-email-help" className="m-0 text-sm text-muted-foreground">
                Without one, notices wait for you here. We use it for nothing else.
              </p>
              <Input
                id="notice-email"
                type="email"
                autoComplete="email"
                aria-describedby="notice-email-help"
                className="h-12 max-w-md px-3 text-base md:text-base"
              />
            </div>
            <div className="pt-6">
              <Button type="submit">Save notification settings</Button>
            </div>
          </form>
        </section>

        <section aria-labelledby="passkeys-title" className="grid gap-8">
          <SectionHead index="03" mark="Passkeys" id="passkeys-title" title="How you sign in" />
          <p className="m-0 max-w-prose text-base text-pretty">
            Any of these signs you in to this account. Your voting identity has its own passkey,
            which isn’t listed here: we never see it.
          </p>
          <ul className="m-0 grid list-none border-t-2 border-foreground p-0">
            {passkeys.map((k) => (
              <li
                key={k.name}
                className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 border-b border-border py-4 md:grid-cols-[auto_minmax(0,1fr)_minmax(0,14rem)_minmax(0,14rem)_auto]"
              >
                <span aria-hidden="true">{k.icon}</span>
                <span className="grid gap-0.5">
                  <span className="font-semibold">{k.name}</span>
                  <span className="text-sm text-muted-foreground">{k.kind}</span>
                </span>
                <span className="col-start-2 font-mono text-xs md:col-start-auto">
                  Added {k.created}
                </span>
                <span className="col-start-2 font-mono text-xs md:col-start-auto">
                  Last used {k.used}
                </span>
                <span className="col-start-2 md:col-start-auto">
                  {passkeys.length > 1 ? (
                    <Button
                      variant="link"
                      className="px-0 md:px-5"
                      onClick={() => setPasskeys(passkeys.filter((p) => p.name !== k.name))}
                    >
                      Remove<span className="sr-only"> {k.name}</span>
                    </Button>
                  ) : (
                    <span className="text-sm text-muted-foreground">Your last passkey</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <div>
            <Button variant="outline">
              <KeyRound aria-hidden="true" data-icon="inline-start" />
              Add a passkey
            </Button>
          </div>
        </section>

        <section aria-labelledby="delete-title" className="grid gap-6 lg:grid-cols-12">
          <div className="lg:col-span-12">
            <SectionHead index="04" mark="Delete" id="delete-title" title="Delete your account" />
          </div>
          <div className="grid gap-4 text-base text-pretty lg:col-span-7">
            <p className="m-0">
              This removes your account, your drafts and your notification settings from our
              servers.
            </p>
            <p className="m-0">
              Polls you published stay on the record: their definitions, ballots and results are
              permanent, and moderation decisions about them stay in the public log. Your voting
              identity and receipts are on your device and are not affected.
            </p>
            <div>
              <AlertDialog>
                <AlertDialogTrigger render={<Button variant="destructive" />}>
                  Delete account
                </AlertDialogTrigger>
                <AlertDialogContent className="data-[size=default]:max-w-md data-[size=default]:sm:max-w-md">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="text-lg">Delete your account?</AlertDialogTitle>
                    <AlertDialogDescription className="text-sm">
                      Your drafts and settings go now and can’t be recovered. Your four published
                      polls stay on the record.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep my account</AlertDialogCancel>
                    <AlertDialogAction variant="destructive">Delete account</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </section>
      </Frame>
    </MockShell>
  );
}
