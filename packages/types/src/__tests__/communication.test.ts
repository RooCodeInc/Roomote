import {
  CHAT_DESTINATION_LOOKUP_MAX_LIMIT,
  chatDestinationLookupInputSchema,
} from '../communication';

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
