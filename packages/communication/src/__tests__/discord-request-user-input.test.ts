import { describe, expect, it } from 'vitest';

import {
  buildDiscordRequestUserInputAnswerCallbackData,
  buildDiscordRequestUserInputButtons,
  buildDiscordRequestUserInputCancelCallbackData,
  buildDiscordRequestUserInputPromptText,
  parseDiscordRequestUserInputAnswerCallbackData,
  parseDiscordRequestUserInputCancelCallbackData,
} from '../discord-request-user-input';

const sampleQuestion = {
  id: 'q1',
  header: 'Bump',
  question: 'What bump level should I cut?',
  isOther: true,
  isSecret: false,
  options: [
    { label: 'minor', description: 'Recommended' },
    { label: 'patch', description: 'Bug fixes only' },
    { label: 'major', description: 'Breaking change' },
  ],
};

describe('discord request_user_input helpers', () => {
  it('round-trips compact answer callback ids', () => {
    const customId = buildDiscordRequestUserInputAnswerCallbackData({
      runId: 42,
      requestId: 'rui:session:turn:callid12',
      questionIndex: 0,
      optionIndex: 2,
    });
    expect(customId.length).toBeLessThanOrEqual(100);
    expect(parseDiscordRequestUserInputAnswerCallbackData(customId)).toEqual({
      runId: 42,
      questionIndex: 0,
      optionIndex: 2,
      requestToken: 'callid12',
    });
  });

  it('round-trips cancel callback ids', () => {
    const customId = buildDiscordRequestUserInputCancelCallbackData({
      runId: 7,
      requestId: 'rui:session:turn:callid12',
    });
    expect(parseDiscordRequestUserInputCancelCallbackData(customId)).toEqual({
      runId: 7,
      requestToken: 'callid12',
    });
  });

  it('builds option buttons and cancel for a single-question prompt', () => {
    const text = buildDiscordRequestUserInputPromptText({
      requestId: 'rui:1',
      questions: [sampleQuestion],
    });
    expect(text).toContain('What bump level should I cut?');
    expect(text).toContain('minor');

    const buttons = buildDiscordRequestUserInputButtons({
      runId: 99,
      request: {
        requestId: 'rui:session:turn:callid12',
        questions: [sampleQuestion],
      },
    });
    expect(buttons).toBeDefined();
    expect(buttons![0]).toHaveLength(3);
    expect(buttons!.at(-1)?.[0]?.text).toBe('Cancel');
  });

  it('renders the current question and option buttons for multi-question prompts', () => {
    const text = buildDiscordRequestUserInputPromptText({
      requestId: 'rui:1',
      questions: [
        sampleQuestion,
        {
          id: 'q2',
          header: 'Notes',
          question: 'Any release notes overrides?',
          isOther: true,
          isSecret: false,
        },
      ],
    });
    expect(text).toContain('Question 1 of 2');
    expect(text).not.toContain('Question 2 of 2');
    expect(text).toContain('Pick a button');

    const buttons = buildDiscordRequestUserInputButtons({
      runId: 99,
      request: {
        requestId: 'rui:session:turn:callid12',
        questions: [sampleQuestion, { ...sampleQuestion, id: 'q2' }],
      },
    });
    expect(buttons?.[0]).toHaveLength(3);
    expect(buttons?.at(-1)?.[0]?.text).toBe('Cancel');
  });

  it('renders a later multi-question prompt from its current question index', () => {
    const secondQuestion = {
      ...sampleQuestion,
      id: 'q2',
      question: 'Which release branch should I use?',
    };
    const text = buildDiscordRequestUserInputPromptText({
      requestId: 'rui:1',
      questions: [sampleQuestion, secondQuestion],
      currentQuestionIndex: 1,
    });

    expect(text).toContain('Question 2 of 2');
    expect(text).toContain('Which release branch should I use?');
    expect(text).not.toContain('What bump level should I cut?');

    const buttons = buildDiscordRequestUserInputButtons({
      runId: 99,
      request: {
        requestId: 'rui:session:turn:callid12',
        questions: [sampleQuestion, secondQuestion],
        currentQuestionIndex: 1,
      },
    });
    expect(buttons?.[0]?.[0]?.callbackData).toContain(':1:0:');
  });

  it('renders every question for providers that collect one text reply', () => {
    const text = buildDiscordRequestUserInputPromptText({
      requestId: 'rui:1',
      questions: [
        sampleQuestion,
        { ...sampleQuestion, id: 'q2', question: 'Second question?' },
      ],
      showAllQuestions: true,
    });

    expect(text).toContain('Question 1 of 2');
    expect(text).toContain('Question 2 of 2');
    expect(text).toContain('one answer per line');
  });

  it('reserves a button row for Cancel when options exceed Discord row capacity', () => {
    const buttons = buildDiscordRequestUserInputButtons({
      runId: 99,
      request: {
        requestId: 'rui:session:turn:callid12',
        questions: [
          {
            ...sampleQuestion,
            options: Array.from({ length: 21 }, (_, index) => ({
              label: `Option ${index + 1}`,
              description: '',
            })),
          },
        ],
      },
    });

    expect(buttons).toHaveLength(5);
    expect(buttons?.at(-1)?.[0]?.text).toBe('Cancel');
  });
});
