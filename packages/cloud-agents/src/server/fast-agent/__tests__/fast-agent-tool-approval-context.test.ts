import type { ModelMessage } from 'ai';

import { resolveFastAgentToolApprovalUserRequest } from '../fast-agent-tool-approval-context';

function userMessage(text: string, turnSource: string): ModelMessage {
  return {
    role: 'user',
    content: text,
    metadata: { visibleInTranscript: true, turnSource },
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
