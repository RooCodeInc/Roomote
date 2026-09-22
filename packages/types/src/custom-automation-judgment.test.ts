import {
  CUSTOM_AUTOMATION_JUDGMENT_GOAL_MAX_LENGTH,
  deriveCustomAutomationJudgmentSpec,
} from './custom-automation-judgment';

describe('custom automation judgment specs', () => {
  it('derives one bounded versioned noul question from the saved goal', () => {
    const spec = deriveCustomAutomationJudgmentSpec(
      `  ${'goal '.repeat(1_000)}  `,
    );

    expect(spec).toMatchObject({
      version: 1,
      questionId: 'goal_addressed',
      question: {
        type: 'noul',
        criteria: {
          true: expect.any(String),
          false: expect.any(String),
        },
      },
    });
    expect(spec.goal.length).toBeLessThanOrEqual(
      CUSTOM_AUTOMATION_JUDGMENT_GOAL_MAX_LENGTH,
    );
    expect(spec.goal).toContain('goal');
  });
});
