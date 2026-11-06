import {
  CHAT_DESTINATION_LOOKUP_MAX_LIMIT,
  chatDestinationLookupInputSchema,
  normalizeChannelMessagesRequest,
} from '../communication';

describe('channel history request normalization', () => {
  it('keeps root-history and reply bounds independent and removes non-wire fields', () => {
    expect(
      normalizeChannelMessagesRequest({
        channel: ' C123 ',
        oldest: ' 100 ',
        latest: ' 300 ',
        historyLatest: ' 200 ',
        actingUserId: 'not-a-wire-field',
      }),
    ).toEqual({
      channel: 'C123',
      oldest: '100',
      latest: '300',
      historyLatest: '200',
    });
  });

  it('preserves tolerant HTTP handling of empty and non-string optional fields', () => {
    expect(
      normalizeChannelMessagesRequest({
        channel: ' ',
        oldest: null,
        latest: 300,
        historyLatest: undefined,
      }),
    ).toEqual({});
  });
});

describe('chatDestinationLookupInputSchema', () => {
  it('rejects unfiltered lookup', () => {
    expect(chatDestinationLookupInputSchema.safeParse({}).success).toBe(false);
  });

  it('accepts narrow provider-scoped self lookup', () => {
    expect(
      chatDestinationLookupInputSchema.parse({
        provider: 'telegram',
        kind: 'self',
      }),
    ).toEqual({ provider: 'telegram', kind: 'self' });
  });

  it('rejects directory selectors for self lookup', () => {
    expect(
      chatDestinationLookupInputSchema.safeParse({
        provider: 'slack',
        kind: 'self',
        query: 'me',
      }).success,
    ).toBe(false);
  });

  it.each(['person', 'channel'] as const)(
    'requires one targeted selector for Slack %s lookup',
    (kind) => {
      expect(
        chatDestinationLookupInputSchema.safeParse({
          provider: 'slack',
          kind,
        }).success,
      ).toBe(false);
      expect(
        chatDestinationLookupInputSchema.safeParse({
          provider: 'slack',
          kind,
          query: 'shipping',
          destination: `slack:T1:${kind === 'person' ? 'member' : 'channel'}:X1`,
        }).success,
      ).toBe(false);
    },
  );

  it('rejects unsupported provider/kind pairs and oversized pages', () => {
    expect(
      chatDestinationLookupInputSchema.safeParse({
        provider: 'telegram',
        kind: 'person',
        query: 'alice',
      }).success,
    ).toBe(false);
    expect(
      chatDestinationLookupInputSchema.safeParse({
        provider: 'slack',
        kind: 'channel',
        query: 'shipping',
        limit: CHAT_DESTINATION_LOOKUP_MAX_LIMIT + 1,
      }).success,
    ).toBe(false);
  });

  it('validates exact selector kind and workspace', () => {
    expect(
      chatDestinationLookupInputSchema.safeParse({
        provider: 'slack',
        kind: 'person',
        destination: 'slack:T1:member:U1',
        workspaceId: 'T1',
      }).success,
    ).toBe(true);
    expect(
      chatDestinationLookupInputSchema.safeParse({
        provider: 'slack',
        kind: 'person',
        destination: 'slack:T1:channel:C1',
      }).success,
    ).toBe(false);
    expect(
      chatDestinationLookupInputSchema.safeParse({
        provider: 'slack',
        kind: 'channel',
        destination: 'slack:T1:channel:C1',
        workspaceId: 'T2',
      }).success,
    ).toBe(false);
  });
});
