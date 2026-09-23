import { buildSlackLiveTaskTitle } from '../live-task-stream';

describe('buildSlackLiveTaskTitle', () => {
  it('removes leading recognized skill invocations from the display title', () => {
    const prompt =
      '$implement-changes $review-code\n\nFix the Slack task title cleanup';

    expect(buildSlackLiveTaskTitle(prompt)).toBe(
      'Fix the Slack task title cleanup',
    );
    expect(prompt).toBe(
      '$implement-changes $review-code\n\nFix the Slack task title cleanup',
    );
  });

  it('removes leading slash skill invocations from the display title', () => {
    expect(
      buildSlackLiveTaskTitle(
        '/review-code\n\nFix the Slack task title cleanup',
      ),
    ).toBe('Fix the Slack task title cleanup');
  });

  it.each([
    ['/review-code: Fix the task', 'Fix the task'],
    ['$review-code, Fix the task', 'Fix the task'],
  ])(
    'removes a punctuation-delimited recognized skill: %s',
    (prompt, title) => {
      expect(buildSlackLiveTaskTitle(prompt)).toBe(title);
    },
  );

  it.each([
    [
      '$implement-changes $not-a-real-skill Fix the task',
      '$not-a-real-skill Fix the task',
    ],
    ['$not-a-real-skill Fix the task', '$not-a-real-skill Fix the task'],
    ['$doctor Fix the task', '$doctor Fix the task'],
    ['Estimate $100 for the task', 'Estimate $100 for the task'],
    [
      'Explain $implement-changes in the task',
      'Explain $implement-changes in the task',
    ],
  ])('keeps non-leading or unresolved dollar text: %s', (prompt, title) => {
    expect(buildSlackLiveTaskTitle(prompt)).toBe(title);
  });

  it('keeps a token-only prompt non-empty', () => {
    expect(buildSlackLiveTaskTitle('$implement-changes')).toBe(
      '$implement-changes',
    );
  });
});
