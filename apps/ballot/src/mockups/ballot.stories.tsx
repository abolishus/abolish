import { Button, cn } from "@abolishus/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowDown, ArrowUp, Check, Plus, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { expect, userEvent, within } from "storybook/test";

import { LEVY, PARK, PARK_LIMITED, TENANTS, type BallotElection } from "./fixtures.ts";
import { ACTION, BallotFrame, Notice } from "./frame.tsx";

const NUMBER_WORDS = ["none", "one", "two", "three", "four", "five", "six"];
const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th"];

function ordinal(i: number): string {
  return ORDINALS[i] ?? `${i + 1}th`;
}

function words(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/**
 * The question, verbatim, then the instructions, then the options: the order
 * the Center for Civic Design's field guides set, so nobody chooses before
 * they've read how.
 */
function QuestionScreen({
  election,
  instructions,
  primaryLabel,
  onContinue,
  children,
}: {
  election: BallotElection;
  instructions: ReactNode;
  primaryLabel: string;
  onContinue: () => void;
  children: ReactNode;
}) {
  return (
    <BallotFrame
      election={election}
      step="Choose"
      primary={
        <Button size="lg" className={ACTION} onClick={onContinue}>
          {primaryLabel}
        </Button>
      }
      secondary={
        <Button size="lg" variant="outline" className={ACTION}>
          Back
        </Button>
      }
    >
      <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase">
        Question 1 of 1
      </p>
      <h1 className="mt-4 mb-0 font-heading text-2xl leading-snug font-semibold text-pretty sm:text-3xl">
        {election.question}
      </h1>
      <div className="mt-6 border-y-2 border-foreground py-3 text-lg">{instructions}</div>
      <div className="mt-6 grid gap-6">{children}</div>
    </BallotFrame>
  );
}

/** One option: the whole row is the target, and its state shows as a mark and in words. */
function OptionRow({
  type,
  name,
  label,
  note,
  checked,
  onChange,
}: {
  type: "radio" | "checkbox";
  name: string;
  label: string;
  note?: string | undefined;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={cn(
        "flex min-h-18 cursor-pointer items-center gap-4 border-2 px-4 py-3 has-focus-visible:ring-3 has-focus-visible:ring-ring",
        checked ? "border-foreground" : "border-border hover:border-muted-foreground",
      )}
    >
      <input type={type} name={name} checked={checked} onChange={onChange} className="sr-only" />
      <span
        aria-hidden="true"
        className={cn(
          "flex size-8 shrink-0 items-center justify-center border-2",
          type === "radio" && "rounded-full",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-foreground bg-background",
        )}
      >
        {checked ? <Check className="size-5" strokeWidth={3} /> : null}
      </span>
      <span className="grid flex-1 gap-0.5">
        <span className="text-lg leading-snug font-medium">{label}</span>
        {note === undefined ? null : <span className="text-sm text-muted-foreground">{note}</span>}
      </span>
      {checked ? (
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-xs font-semibold tracking-widest uppercase"
        >
          Selected
        </span>
      ) : null}
    </label>
  );
}

function PluralityBallot({ election }: { election: BallotElection }) {
  const name = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const [warned, setWarned] = useState(false);
  const label = election.options.find((o) => o.key === chosen)?.label;
  return (
    <QuestionScreen
      election={election}
      instructions={
        <>
          <p className="m-0 font-semibold">Choose one.</p>
          <p className="m-0 text-base text-muted-foreground">
            To change your choice, choose a different option.
          </p>
        </>
      }
      primaryLabel={warned && chosen === null ? "Continue with no choice" : "Continue to review"}
      onContinue={() => setWarned(chosen === null)}
    >
      <fieldset className="m-0 grid gap-3 border-0 p-0">
        <legend className="sr-only">Choose one</legend>
        {election.options.map((option) => (
          <OptionRow
            key={option.key}
            type="radio"
            name={name}
            label={option.label}
            note={option.note}
            checked={chosen === option.key}
            onChange={() => {
              setChosen(option.key);
              setWarned(false);
            }}
          />
        ))}
      </fieldset>
      <p role="status" className="m-0">
        {label === undefined ? "You have not chosen an option." : `You have chosen: ${label}.`}
      </p>
      {warned && chosen === null ? (
        <Notice title="You haven't chosen an option">
          <p className="m-0">
            If you continue, this question is left blank. A blank ballot is recorded on the board
            but counts for no option. You can still choose one above.
          </p>
        </Notice>
      ) : null}
    </QuestionScreen>
  );
}

function ApprovalBallot({ election }: { election: BallotElection }) {
  const name = useId();
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [warned, setWarned] = useState(false);
  const total = election.options.length;
  const limited = election.maxChoices < total;
  const blockedLabel = election.options.find((o) => o.key === blocked)?.label;
  function toggle(key: string) {
    setWarned(false);
    if (chosen.includes(key)) {
      setChosen(chosen.filter((k) => k !== key));
      setBlocked(null);
    } else if (chosen.length >= election.maxChoices) {
      setBlocked(key);
    } else {
      setChosen([...chosen, key]);
      setBlocked(null);
    }
  }
  return (
    <QuestionScreen
      election={election}
      instructions={
        limited ? (
          <>
            <p className="m-0 font-semibold">Choose up to {words(election.maxChoices)}.</p>
            <p className="m-0 text-base text-muted-foreground">
              Each option you choose counts as one approval. To remove a choice, choose it again.
            </p>
          </>
        ) : (
          <>
            <p className="m-0 font-semibold">Choose all the options you support.</p>
            <p className="m-0 text-base text-muted-foreground">
              You can choose any number, from none to all {words(total)}. Each one counts as one
              approval. To remove a choice, choose it again.
            </p>
          </>
        )
      }
      primaryLabel={
        warned && chosen.length === 0 ? "Continue with no choice" : "Continue to review"
      }
      onContinue={() => setWarned(chosen.length === 0)}
    >
      <fieldset className="m-0 grid gap-3 border-0 p-0">
        <legend className="sr-only">
          {limited ? `Choose up to ${words(election.maxChoices)}` : "Choose any number"}
        </legend>
        {election.options.map((option) => (
          <OptionRow
            key={option.key}
            type="checkbox"
            name={name}
            label={option.label}
            note={option.note}
            checked={chosen.includes(option.key)}
            onChange={() => toggle(option.key)}
          />
        ))}
      </fieldset>
      <p role="status" className="m-0 flex items-baseline justify-between gap-4">
        <span>
          <span className="font-semibold tabular-nums">
            {chosen.length} of {total}
          </span>{" "}
          chosen
        </span>
        {limited ? (
          <span className="text-sm text-muted-foreground">
            {election.maxChoices - chosen.length === 0
              ? "No more choices left"
              : `${words(election.maxChoices - chosen.length)} more allowed`}
          </span>
        ) : null}
      </p>
      {blockedLabel === undefined ? null : (
        <Notice tone="pending" title={`You have already chosen ${words(election.maxChoices)}`}>
          <p className="m-0">
            That is the most this question allows. To choose “{blockedLabel}”, first remove one of
            your other choices.
          </p>
        </Notice>
      )}
      {warned && chosen.length === 0 ? (
        <Notice title="You haven't chosen any options">
          <p className="m-0">
            If you continue, this question is left blank. A blank ballot is recorded on the board
            but approves no option.
          </p>
        </Notice>
      ) : null}
    </QuestionScreen>
  );
}

function RankedBallot({ election }: { election: BallotElection }) {
  const [ranking, setRanking] = useState<readonly string[]>([]);
  const [said, setSaid] = useState("");
  const [warned, setWarned] = useState(false);
  const labelOf = (key: string) => election.options.find((o) => o.key === key)?.label ?? key;
  const unranked = election.options.filter((o) => !ranking.includes(o.key));
  function update(next: readonly string[], key: string) {
    setRanking(next);
    setWarned(false);
    const at = next.indexOf(key);
    setSaid(
      at === -1
        ? `${labelOf(key)} removed from your ranking.`
        : `${labelOf(key)} is your ${ordinal(at)} choice.`,
    );
  }
  function move(key: string, by: -1 | 1) {
    const from = ranking.indexOf(key);
    const to = from + by;
    if (to < 0 || to >= ranking.length) return;
    const next = [...ranking];
    next[from] = next[to] ?? key;
    next[to] = key;
    update(next, key);
  }
  return (
    <QuestionScreen
      election={election}
      instructions={
        <>
          <p className="m-0 font-semibold">Rank the candidates in order of preference.</p>
          <p className="m-0 text-base text-muted-foreground">
            Add your 1st choice, then your 2nd, and so on. You can rank as many or as few as you
            like. Use Move up and Move down to change the order.
          </p>
        </>
      }
      primaryLabel={
        warned && ranking.length === 0 ? "Continue with no ranking" : "Continue to review"
      }
      onContinue={() => setWarned(ranking.length === 0)}
    >
      <section aria-labelledby="ranking-heading" className="grid gap-3">
        <h2 id="ranking-heading" className="m-0 font-heading text-lg font-semibold">
          Your ranking
        </h2>
        {ranking.length === 0 ? (
          <p className="m-0 border-2 border-dashed border-border px-4 py-6 text-muted-foreground">
            You haven't ranked anyone yet.
          </p>
        ) : (
          <ol aria-label="Your ranking" className="m-0 grid list-none gap-3 p-0">
            {ranking.map((key, i) => (
              <li key={key} className="grid gap-3 border-2 border-foreground px-4 py-3">
                <div className="flex items-center gap-4">
                  <span
                    aria-hidden="true"
                    className="flex size-10 shrink-0 items-center justify-center bg-primary font-mono text-lg font-semibold text-primary-foreground tabular-nums"
                  >
                    {i + 1}
                  </span>
                  <span className="grid">
                    <span className="font-mono text-xs font-semibold tracking-widest uppercase">
                      {ordinal(i)} choice
                    </span>
                    <span className="text-lg leading-snug font-medium">{labelOf(key)}</span>
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Button
                    variant="outline"
                    aria-label={`Move up: ${labelOf(key)}`}
                    className="px-2"
                    disabled={i === 0}
                    onClick={() => move(key, -1)}
                  >
                    <ArrowUp aria-hidden="true" />
                    Move up
                  </Button>
                  <Button
                    variant="outline"
                    aria-label={`Move down: ${labelOf(key)}`}
                    className="px-2"
                    disabled={i === ranking.length - 1}
                    onClick={() => move(key, 1)}
                  >
                    <ArrowDown aria-hidden="true" />
                    Move down
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`Remove: ${labelOf(key)}`}
                    className="px-2"
                    onClick={() =>
                      update(
                        ranking.filter((k) => k !== key),
                        key,
                      )
                    }
                  >
                    <X aria-hidden="true" />
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
      {unranked.length === 0 ? null : (
        <section aria-labelledby="unranked-heading" className="grid gap-3">
          <h2 id="unranked-heading" className="m-0 font-heading text-lg font-semibold">
            Not ranked
          </h2>
          <ul aria-label="Not ranked" className="m-0 grid list-none gap-3 p-0">
            {unranked.map((option) => (
              <li
                key={option.key}
                className="flex flex-wrap items-center justify-between gap-3 border-2 border-border px-4 py-3"
              >
                <span className="grid">
                  <span className="text-lg leading-snug font-medium">{option.label}</span>
                  {option.note === undefined ? null : (
                    <span className="text-sm text-muted-foreground">{option.note}</span>
                  )}
                </span>
                <Button
                  variant="outline"
                  aria-label={`Add as ${ordinal(ranking.length)} choice: ${option.label}`}
                  onClick={() => update([...ranking, option.key], option.key)}
                >
                  <Plus aria-hidden="true" />
                  Add as {ordinal(ranking.length)} choice
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p role="status" className="m-0 text-sm text-muted-foreground">
        {said === ""
          ? `You have ranked ${ranking.length} of ${election.options.length}.`
          : `${said} You have ranked ${ranking.length} of ${election.options.length}.`}
      </p>
      {warned && ranking.length === 0 ? (
        <Notice title="You haven't ranked anyone">
          <p className="m-0">
            If you continue, this question is left blank. A blank ballot is recorded on the board
            but counts for no candidate.
          </p>
        </Notice>
      ) : null}
    </QuestionScreen>
  );
}

function Ballot({ election }: { election: BallotElection }) {
  switch (election.method) {
    case "plurality":
      return <PluralityBallot election={election} />;
    case "approval":
      return <ApprovalBallot election={election} />;
    case "ranked":
      return <RankedBallot election={election} />;
  }
}

const meta = {
  title: "Mockups/Ballot/Ballot",
  component: Ballot,
  args: { election: LEVY },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Ballot>;

export default meta;
type Story = StoryObj<typeof meta>;

const choosePlurality: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(LEVY.question);
  const yes = canvas.getByRole("radio", { name: "Yes, renew the levy" });
  const no = canvas.getByRole("radio", { name: "No, let it expire" });
  // Nothing is chosen for the voter.
  await expect(yes).not.toBeChecked();
  await expect(no).not.toBeChecked();
  await expect(canvas.queryByText("Selected")).toBeNull();
  await userEvent.click(canvas.getByText("Yes, renew the levy"));
  await expect(yes).toBeChecked();
  await expect(yes.closest("label")).toHaveTextContent("Selected");
  await expect(canvas.getByRole("status")).toHaveTextContent(
    "You have chosen: Yes, renew the levy.",
  );
  await userEvent.click(canvas.getByText("No, let it expire"));
  await expect(yes.closest("label")).not.toHaveTextContent("Selected");
  await expect(no.closest("label")).toHaveTextContent("Selected");
  await expect(canvas.getByRole("status")).toHaveTextContent("You have chosen: No, let it expire.");
};

export const Plurality: Story = { play: choosePlurality };

export const PluralityNoChoice: Story = {
  name: "Plurality, no choice (undervote)",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Continue to review" }));
    await expect(canvas.getByText("You haven't chosen an option")).toBeVisible();
    // Leaving it blank is allowed, but only as a deliberate second step.
    await expect(canvas.getByRole("button", { name: "Continue with no choice" })).toBeVisible();
    await userEvent.click(canvas.getByText("No, let it expire"));
    await expect(canvas.queryByText("You haven't chosen an option")).toBeNull();
    await expect(canvas.getByRole("button", { name: "Continue to review" })).toBeVisible();
  },
};

export const Approval: Story = {
  args: { election: PARK },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const count = canvas.getByRole("status");
    await expect(count).toHaveTextContent("0 of 4 chosen");
    await userEvent.click(canvas.getByText("Better lighting on the river path"));
    await expect(count).toHaveTextContent("1 of 4 chosen");
    await userEvent.click(canvas.getByText("Two hundred new street trees"));
    await expect(count).toHaveTextContent("2 of 4 chosen");
    await expect(
      canvas.getByRole("checkbox", { name: "Two hundred new street trees" }).closest("label"),
    ).toHaveTextContent("Selected");
    await userEvent.click(canvas.getByText("Better lighting on the river path"));
    await expect(count).toHaveTextContent("1 of 4 chosen");
    await expect(
      canvas.getByRole("checkbox", { name: "Better lighting on the river path" }),
    ).not.toBeChecked();
  },
};

export const ApprovalOvervote: Story = {
  name: "Approval, too many (overvote)",
  args: { election: PARK_LIMITED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Choose up to two.")).toBeVisible();
    await userEvent.click(canvas.getByText("Better lighting on the river path"));
    await userEvent.click(canvas.getByText("Public toilets open all year"));
    await userEvent.click(canvas.getByText("Two hundred new street trees"));
    // The third choice is refused in words, and nothing already chosen changes.
    await expect(canvas.getByText("You have already chosen two")).toBeVisible();
    await expect(canvas.getByText(/To choose “Two hundred new street trees”/)).toBeVisible();
    await expect(
      canvas.getByRole("checkbox", { name: "Two hundred new street trees" }),
    ).not.toBeChecked();
    await expect(canvas.getByRole("status")).toHaveTextContent("2 of 4 chosen");
    await userEvent.click(canvas.getByText("Public toilets open all year"));
    await expect(canvas.queryByText("You have already chosen two")).toBeNull();
  },
};

export const RankedChoice: Story = {
  args: { election: TENANTS },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("You haven't ranked anyone yet.")).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Add as 1st choice: Mara Lindqvist" }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Add as 2nd choice: Adaeze Okafor" }));
    await userEvent.click(canvas.getByRole("button", { name: "Add as 3rd choice: Tomás Reyes" }));
    const ranked = () =>
      within(canvas.getByRole("list", { name: "Your ranking" })).getAllByRole("listitem");
    await expect(ranked().map((li) => li.textContent?.slice(0, 40))).toEqual([
      expect.stringContaining("1st choiceMara Lindqvist"),
      expect.stringContaining("2nd choiceAdaeze Okafor"),
      expect.stringContaining("3rd choiceTomás Reyes"),
    ]);
    await userEvent.click(canvas.getByRole("button", { name: "Move up: Tomás Reyes" }));
    await expect(ranked()[1]).toHaveTextContent("2nd choiceTomás Reyes");
    await expect(ranked()[2]).toHaveTextContent("3rd choiceAdaeze Okafor");
    await expect(canvas.getByRole("status")).toHaveTextContent("Tomás Reyes is your 2nd choice.");
    // The first can't move up and the last can't move down.
    await expect(canvas.getByRole("button", { name: "Move up: Mara Lindqvist" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Move down: Adaeze Okafor" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("button", { name: "Remove: Mara Lindqvist" }));
    await expect(ranked()[0]).toHaveTextContent("1st choiceTomás Reyes");
    await expect(
      canvas.getByRole("button", { name: "Add as 3rd choice: Mara Lindqvist" }),
    ).toBeVisible();
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: choosePlurality,
};

export const RankedChoiceDark: Story = {
  name: "Ranked choice, dark",
  args: { election: TENANTS },
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Add as 1st choice: Tomás Reyes" }));
    await userEvent.click(canvas.getByRole("button", { name: "Add as 2nd choice: Adaeze Okafor" }));
    await userEvent.click(canvas.getByRole("button", { name: "Move down: Tomás Reyes" }));
    const ranked = within(canvas.getByRole("list", { name: "Your ranking" })).getAllByRole(
      "listitem",
    );
    await expect(ranked[0]).toHaveTextContent("1st choiceAdaeze Okafor");
    await expect(ranked[1]).toHaveTextContent("2nd choiceTomás Reyes");
  },
};
