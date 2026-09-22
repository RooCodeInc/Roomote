import {
  CUSTOM_AUTOMATION_DECISION_GOAL_MAX_LENGTH,
  CUSTOM_AUTOMATION_DECISION_RESULT_MAX_LENGTH,
  CUSTOM_AUTOMATION_DECISION_RULE_VERSION,
  deriveCustomAutomationDecisionRule,
} from './custom-automation-decision-rule';

describe('custom automation decision rules', () => {
  it('derives typed inputs, closed outcomes, and code-owned consequences', () => {
    const rule = deriveCustomAutomationDecisionRule('Review deployment logs.');

    expect(rule).toEqual({
      version: CUSTOM_AUTOMATION_DECISION_RULE_VERSION,
      goalPreview: 'Review deployment logs.',
      inputs: {
        goal: {
          type: 'text',
          source: 'automation_prompt',
          maxChars: CUSTOM_AUTOMATION_DECISION_GOAL_MAX_LENGTH,
        },
        result: {
          type: 'text',
          source: 'automation_result',
          maxChars: CUSTOM_AUTOMATION_DECISION_RESULT_MAX_LENGTH,
        },
      },
      question: expect.objectContaining({
        id: 'result_outcome',
        type: 'choice',
        criteria: expect.objectContaining({
          addressed: expect.any(String),
          needs_review: expect.any(String),
          no_match: expect.any(String),
        }),
      }),
      allowedOutcomes: ['addressed', 'needs_review', 'no_match'],
      consequences: {
        addressed: 'preserve_delivery',
        needs_review: 'preserve_delivery',
        no_match: 'preserve_delivery',
      },
    });
  });
});
