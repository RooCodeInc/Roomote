import {
  getTaskReportConsumerFromPayload,
  shouldSuppressDirectCommunicationContext,
} from '../fast-agent';

const fastAgentParent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  conversation: {
    surface: 'slack',
    workspaceId: 'T123',
    conversationId: '111.222',
    replyTarget: { channelId: 'C123', threadId: '111.222' },
  },
};

describe('shouldSuppressDirectCommunicationContext', () => {
  it.each([
    [{ communicationContextInherited: true }, 'explicit inheritance'],
    [{ reportConsumer: 'orchestrator' }, 'orchestrator report consumer'],
    [{ reportConsumer: 'fast-orchestrator' }, 'legacy report consumer'],
    [{ fastAgentParent }, 'Fast parent'],
  ])('recognizes %j from %s', (payload, _label) => {
    expect(shouldSuppressDirectCommunicationContext(payload)).toBe(true);
  });

  it.each([
    undefined,
    {},
    { communicationContextInherited: false },
    { reportConsumer: 'direct-user' },
  ])('keeps direct-user payloads reply-capable: %j', (payload) => {
    expect(shouldSuppressDirectCommunicationContext(payload)).toBe(false);
    expect(getTaskReportConsumerFromPayload(payload)).toBe('direct-user');
  });
});
