import { describe, expect, it } from 'vitest';

import { customAutomationRunWhenSchema } from './custom-automation-run-when';

describe('custom automation runWhen schema', () => {
  it('parses yes/no and score conditions with explicit boundaries', () => {
    const parsed = customAutomationRunWhenSchema.parse({
      all: [
        {
          id: 'new_regression',
          ask: 'Does `report` describe a new regression?',
          type: 'yes_no',
          criteria: {
            true: 'A new regression is evidenced.',
            false: 'No new regression is evidenced.',
          },
          min: 0.75,
        },
        {
          id: 'impact',
          ask: 'How much impact does `report` describe?',
          type: 'score',
          levels: [
            { id: 'none', description: 'No user impact is described.' },
            { id: 'moderate', description: 'A core flow is degraded.' },
          ],
          min: 'moderate',
        },
      ],
    });

    expect(parsed.onUncertain).toBe('skip');
    expect(parsed.all?.[1]).toMatchObject({
      id: 'impact',
      min: 'moderate',
      minConfidence: 0.6,
    });
  });

  it('parses choice conditions and accepted option IDs', () => {
    const parsed = customAutomationRunWhenSchema.parse({
      any: [
        {
          id: 'topic',
          ask: 'What is the main topic in `report`?',
          type: 'choice',
          options: {
            regression: 'A new product regression.',
            routine: 'Routine status with no actionable change.',
          },
          oneOf: ['regression'],
        },
      ],
      onUncertain: 'run',
    });

    expect(parsed).toMatchObject({
      onUncertain: 'run',
      any: [{ oneOf: ['regression'], minConfidence: 0.6 }],
    });
  });

  it('rejects invalid thresholds, unknown score levels, and duplicate IDs', () => {
    const base = {
      all: [
        {
          id: 'impact',
          ask: 'How much impact does `report` describe?',
          type: 'score',
          levels: [
            { id: 'none', description: 'No user impact is described.' },
            { id: 'moderate', description: 'A core flow is degraded.' },
          ],
          min: 'severe',
        },
      ],
    };

    expect(customAutomationRunWhenSchema.safeParse(base).success).toBe(false);
    expect(
      customAutomationRunWhenSchema.safeParse({
        all: [
          {
            id: 'condition',
            ask: 'Does `report` qualify?',
            type: 'yes_no',
            criteria: { true: 'It qualifies.', false: 'It does not qualify.' },
            min: 0.5,
          },
          {
            id: 'condition',
            ask: 'Does `report` contain impact?',
            type: 'yes_no',
            criteria: { true: 'It has impact.', false: 'It has no impact.' },
            min: 0.8,
          },
        ],
      }).success,
    ).toBe(false);
  });
});
