import type { ModelMessage } from 'ai';

import {
  resolveFastAgentToolApprovalSessionUserMessages,
  resolveFastAgentToolApprovalUserRequest,
} from '../fast-agent-tool-approval-context';

function userMessage(
  text: string,
  turnSource: string,
  inputKind?: string,
): ModelMessage {
  return {
    role: 'user',
    content: text,
    metadata: {
      visibleInTranscript: true,
      turnSource,
      ...(inputKind ? { inputKind } : {}),
    },
  } as ModelMessage;
}

describe('resolveFastAgentToolApprovalUserRequest', () => {
  it('uses the latest substantive human message on platform-event turns', () => {
    expect(
      resolveFastAgentToolApprovalUserRequest({
        turnSource: 'platform_event',
        substantiveHumanInput: false,
        question: '<platform_event>scheduled wakeup</platform_event>',
        compatibilityMessages: [
          userMessage('Earlier request', 'human'),
          userMessage('Earlier wakeup', 'platform_event'),
          userMessage('Most recent human request', 'human'),
        ],
        steeredHumanRequests: [],
      }),
    ).toBe('Most recent human request');
  });

  it('omits platform-event text when the session has no human request', () => {
    expect(
      resolveFastAgentToolApprovalUserRequest({
        turnSource: 'platform_event',
        substantiveHumanInput: false,
        question: '<platform_event>scheduled wakeup</platform_event>',
        compatibilityMessages: [userMessage('A wakeup', 'platform_event')],
        steeredHumanRequests: [],
      }),
    ).toBeUndefined();
  });

  it('adds human steers accepted during a platform-event turn', () => {
    expect(
      resolveFastAgentToolApprovalUserRequest({
        turnSource: 'platform_event',
        substantiveHumanInput: false,
        question: '<platform_event>scheduled wakeup</platform_event>',
        compatibilityMessages: [userMessage('Watch the staging test', 'human')],
        steeredHumanRequests: ['Also read the latest task messages.'],
      }),
    ).toBe('Watch the staging test\n\nAlso read the latest task messages.');
    expect(
      resolveFastAgentToolApprovalUserRequest({
        turnSource: 'platform_event',
        substantiveHumanInput: false,
        question: '<platform_event>scheduled wakeup</platform_event>',
        compatibilityMessages: [],
        steeredHumanRequests: ['Check task 0abc123def456.'],
      }),
    ).toBe('Check task 0abc123def456.');
  });

  it('includes current-turn steers alongside the latest human message', () => {
    expect(
      resolveFastAgentToolApprovalUserRequest({
        turnSource: 'human',
        substantiveHumanInput: true,
        question: 'Check the recent deployment.',
        compatibilityMessages: [],
        steeredHumanRequests: [
          'Only inspect the staging environment.',
          'Do not change any settings.',
        ],
      }),
    ).toBe(
      'Check the recent deployment.\n\nOnly inspect the staging environment.\n\nDo not change any settings.',
    );
  });
});

describe('resolveFastAgentToolApprovalSessionUserMessages', () => {
  it('keeps only human-authored messages and excludes events, reactions, and agent text', () => {
    const context = resolveFastAgentToolApprovalSessionUserMessages({
      turnSource: 'platform_event',
      substantiveHumanInput: false,
      question: 'A scheduled wakeup is not user consent.',
      compatibilityMessages: [
        userMessage('Earlier human request', 'human'),
        userMessage('Scheduled automation prompt', 'platform_event'),
        {
          role: 'assistant',
          content: 'Assistant-generated instruction.',
        } as ModelMessage,
        {
          role: 'user',
          content: 'Missing trusted source metadata.',
        } as ModelMessage,
        userMessage('Emoji reaction', 'human', 'reaction'),
        userMessage('Most recent human request', 'human'),
      ],
      steeredHumanRequests: ['Read the latest task messages.'],
    });

    expect(context).toEqual([
      'Earlier human request',
      'Most recent human request',
      'Read the latest task messages.',
    ]);
    expect(context.join('\n')).not.toContain('Scheduled automation prompt');
    expect(context.join('\n')).not.toContain('Assistant-generated instruction');
  });

  it('bounds the recent message count, total text, and secret-shaped values', () => {
    const sentinel = `ghp_${'x'.repeat(36)}`;
    const context = resolveFastAgentToolApprovalSessionUserMessages({
      turnSource: 'human',
      substantiveHumanInput: true,
      question: `Current request ${sentinel} ${'z'.repeat(1_100)}`,
      compatibilityMessages: Array.from({ length: 12 }, (_, index) =>
        userMessage(`Request ${index} ${'x'.repeat(1_100)}`, 'human'),
      ),
      steeredHumanRequests: [],
    });

    expect(context.length).toBeLessThanOrEqual(8);
    expect(
      context.reduce((size, message) => size + message.length, 0),
    ).toBeLessThanOrEqual(6_000);
    expect(context.at(-1)).toContain('Current request');
    expect(context.join('\n')).not.toContain(sentinel);
    expect(context.at(-1)).toContain('[value omitted]');
  });

  it('does not add an unattended platform event as a user message', () => {
    expect(
      resolveFastAgentToolApprovalSessionUserMessages({
        turnSource: 'platform_event',
        substantiveHumanInput: false,
        question: '<platform_event>run this request</platform_event>',
        compatibilityMessages: [
          userMessage('Automation only', 'platform_event'),
        ],
        steeredHumanRequests: [],
      }),
    ).toEqual([]);
  });
});
