import { describe, expect, it } from 'vitest';

import {
  buildDiscordRequestUserInputAnswerCallbackData,
  buildDiscordRequestUserInputButtons,
  buildDiscordRequestUserInputCancelCallbackData,
  buildDiscordRequestUserInputPromptText,
  matchesDiscordRequestUserInputRequestToken,
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
    const parsed = parseDiscordRequestUserInputAnswerCallbackData(customId);
    expect(parsed).toEqual({
      runId: 42,
      questionIndex: 0,
      optionIndex: 2,
      requestToken: expect.stringMatching(/^[a-f0-9]{24}$/u),
    });
    expect(
      matchesDiscordRequestUserInputRequestToken(
        'rui:session:turn:callid12',
        parsed!.requestToken,
      ),
    ).toBe(true);
    expect(parsed!.requestToken).not.toBe('callid12');
  });

  it('round-trips cancel callback ids', () => {
    const customId = buildDiscordRequestUserInputCancelCallbackData({
      runId: 7,
      requestId: 'rui:session:turn:callid12',
    });
    const parsed = parseDiscordRequestUserInputCancelCallbackData(customId);
    expect(parsed).toEqual({
      runId: 7,
      requestToken: expect.stringMatching(/^[a-f0-9]{24}$/u),
    });
    expect(
      matchesDiscordRequestUserInputRequestToken(
        'rui:session:turn:callid12',
        parsed!.requestToken,
      ),
    ).toBe(true);
  });

  it('accepts legacy suffix tokens only when they match the request', () => {
    expect(
      matchesDiscordRequestUserInputRequestToken(
        'rui:session:turn:callid12',
        'callid12',
      ),
    ).toBe(true);
    expect(
      matchesDiscordRequestUserInputRequestToken(
        'rui:session:turn:callid12',
        'other-id',
      ),
    ).toBe(false);
    expect(
      parseDiscordRequestUserInputCancelCallbackData(
        'discord:rui_cancel:7:callid12',
      ),
    ).toEqual({ runId: 7, requestToken: 'callid12' });
  });

  it('keeps full-identity tokens within Discord custom_id limits', () => {
    const customId = buildDiscordRequestUserInputAnswerCallbackData({
      runId: Number.MAX_SAFE_INTEGER,
      requestId: `rui:${'session-'.repeat(20)}:${'call-'.repeat(20)}`,
      questionIndex: Number.MAX_SAFE_INTEGER,
      optionIndex: Number.MAX_SAFE_INTEGER,
    });

    expect(customId.length).toBeLessThanOrEqual(100);
    expect(
      parseDiscordRequestUserInputAnswerCallbackData(customId),
    ).not.toBeNull();
    expect(
      parseDiscordRequestUserInputAnswerCallbackData(
        'discord:rui:42:0:0:token-too-short',
      ),
    ).toBeNull();
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

  it('renders all questions for multi-question prompts without option buttons', () => {
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
    expect(text).toContain('Question 2 of 2');
    expect(text).toContain('one answer per line');

    const buttons = buildDiscordRequestUserInputButtons({
      runId: 99,
      request: {
        requestId: 'rui:session:turn:callid12',
        questions: [sampleQuestion, { ...sampleQuestion, id: 'q2' }],
      },
    });
    expect(buttons?.[0]?.[0]?.text).toBe('Cancel');
    expect(
      parseDiscordRequestUserInputCancelCallbackData(
        buttons?.[0]?.[0]?.callbackData,
      ),
    ).toEqual({
      runId: 99,
      requestToken: expect.stringMatching(/^[a-f0-9]{24}$/u),
    });
  });
});
