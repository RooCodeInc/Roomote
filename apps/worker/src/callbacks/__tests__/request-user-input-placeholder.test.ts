import { describe, expect, it } from 'vitest';

import { isOpenCodeQuestionPlaceholderRequest } from '../request-user-input';

describe('isOpenCodeQuestionPlaceholderRequest', () => {
  it('detects the OpenCode empty-shell question tool payload', () => {
    expect(
      isOpenCodeQuestionPlaceholderRequest({
        questions: [
          {
            id: 'response',
            header: 'Response',
            question: 'Provide the requested input.',
            isOther: true,
            isSecret: false,
            options: [],
          },
        ],
      }),
    ).toBe(true);
  });

  it('does not treat real prompts as placeholders', () => {
    expect(
      isOpenCodeQuestionPlaceholderRequest({
        questions: [
          {
            id: 'drink',
            header: 'Drink',
            question: "What's your favorite drink?",
            isOther: true,
            isSecret: false,
            options: [
              { label: 'Coffee', description: 'Classic caffeine pick' },
            ],
          },
        ],
      }),
    ).toBe(false);
  });
});
