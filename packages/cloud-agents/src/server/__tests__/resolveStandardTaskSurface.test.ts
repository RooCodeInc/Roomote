import {
  isResultOnlyAutomationChatDelivery,
  resolveStandardTaskSurface,
  shouldAttachChatLifecycleInstructions,
} from '../cloud-agent-workflow';

describe('resolveStandardTaskSurface', () => {
  it('prefers Slack channel payload bindings', () => {
    expect(
      resolveStandardTaskSurface({
        hasSlackChannel: true,
        communicationProvider: 'discord',
        taskSurface: 'github',
      }),
    ).toBe('slack');
  });

  it('uses Teams/Telegram/Discord communication provider metadata', () => {
    expect(
      resolveStandardTaskSurface({
        hasSlackChannel: false,
        communicationProvider: 'teams',
        taskSurface: 'github',
      }),
    ).toBe('teams');
  });

  it('propagates GitHub launch surface for issue and PR mention tasks', () => {
    expect(
      resolveStandardTaskSurface({
        hasSlackChannel: false,
        communicationProvider: null,
        taskSurface: 'github',
      }),
    ).toBe('github');
  });

  it('keeps inherited communication context on the web surface', () => {
    expect(
      resolveStandardTaskSurface({
        hasSlackChannel: true,
        communicationProvider: 'slack',
        taskSurface: 'slack',
        communicationContextInherited: true,
      }),
    ).toBe('web');
  });

  it('falls back to web for api/system/missing launch surfaces', () => {
    expect(
      resolveStandardTaskSurface({
        hasSlackChannel: false,
        communicationProvider: null,
        taskSurface: 'api',
      }),
    ).toBe('web');
    expect(
      resolveStandardTaskSurface({
        hasSlackChannel: false,
        communicationProvider: null,
        taskSurface: null,
      }),
    ).toBe('web');
  });
});

describe('isResultOnlyAutomationChatDelivery', () => {
  it('uses result-only delivery for an initial automation report', () => {
    expect(
      isResultOnlyAutomationChatDelivery({ initiatorKind: 'automation' }),
    ).toBe(true);
  });

  it('keeps directed automation follow-ups conversational', () => {
    expect(
      isResultOnlyAutomationChatDelivery({
        initiatorKind: 'automation',
        slackThreadTs: '123.456',
      }),
    ).toBe(false);
    expect(
      isResultOnlyAutomationChatDelivery({
        initiatorKind: 'automation',
        communicationMessageId: 'message-123',
      }),
    ).toBe(false);
  });

  it('does not change user-initiated chat delivery', () => {
    expect(isResultOnlyAutomationChatDelivery({ initiatorKind: 'user' })).toBe(
      false,
    );
  });
});

describe('shouldAttachChatLifecycleInstructions', () => {
  it('omits generic lifecycle instructions from initial automation reports', () => {
    expect(
      shouldAttachChatLifecycleInstructions({
        inheritedCommunicationContext: false,
        resultOnlyChatDelivery: true,
      }),
    ).toBe(false);
  });

  it('keeps lifecycle instructions for directed follow-ups', () => {
    expect(
      shouldAttachChatLifecycleInstructions({
        inheritedCommunicationContext: false,
        resultOnlyChatDelivery: false,
      }),
    ).toBe(true);
  });
});
