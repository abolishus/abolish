import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "./questionnaire.tsx";

const meta = {
  component: Questionnaire,
  render: (args) => (
    <Questionnaire {...args} aria-label="Library levy ballot" onSubmit={(e) => e.preventDefault()}>
      <QuestionnaireProgress />
      <QuestionnaireItem name="levy" required>
        <QuestionnaireTitle>Should the county renew the library levy?</QuestionnaireTitle>
        <QuestionnaireDescription>Non-binding. One answer.</QuestionnaireDescription>
        <QuestionnaireChoices>
          <QuestionnaireChoice value="yes">
            Yes
            <QuestionnaireChoiceDescription>
              Renew at the current rate
            </QuestionnaireChoiceDescription>
          </QuestionnaireChoice>
          <QuestionnaireChoice value="no">No</QuestionnaireChoice>
        </QuestionnaireChoices>
      </QuestionnaireItem>
      <QuestionnaireItem name="branches" multiple>
        <QuestionnaireTitle>Which branches do you use?</QuestionnaireTitle>
        <QuestionnaireChoices>
          <QuestionnaireChoice value="central">Central</QuestionnaireChoice>
          <QuestionnaireChoice value="riverside">Riverside</QuestionnaireChoice>
        </QuestionnaireChoices>
      </QuestionnaireItem>
      <QuestionnaireActions>
        <QuestionnairePrevious />
        <QuestionnaireNext />
        <QuestionnaireSubmit>Cast ballot</QuestionnaireSubmit>
      </QuestionnaireActions>
    </Questionnaire>
  ),
} satisfies Meta<typeof Questionnaire>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("radio", { name: /Yes/ }));
    await expect(canvas.getByRole("radio", { name: /Yes/ })).toBeChecked();
    await userEvent.click(canvas.getByRole("button", { name: "Next" }));
    await expect(
      await canvas.findByRole("group", { name: "Which branches do you use?" }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("checkbox", { name: "Riverside" }));
    await expect(canvas.getByRole("checkbox", { name: "Riverside" })).toBeChecked();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("group", {
        name: "Should the county renew the library levy?",
      }),
    ).toBeVisible();
  },
};
