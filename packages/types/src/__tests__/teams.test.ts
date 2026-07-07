import { buildTeamsMessagePermalink } from '../teams';

describe('buildTeamsMessagePermalink', () => {
  it('builds a teams.microsoft.com deep link for a channel conversation', () => {
    expect(
      buildTeamsMessagePermalink({
        conversationId: '19:channel@thread.v2',
        messageId: '1647012345678',
      }),
    ).toBe(
      'https://teams.microsoft.com/l/message/19%3Achannel%40thread.v2/1647012345678',
    );
  });

  it('appends the tenant id when provided', () => {
    expect(
      buildTeamsMessagePermalink({
        conversationId: '19:channel@thread.v2',
        messageId: '1647012345678',
        tenantId: 'tenant-abc',
      }),
    ).toBe(
      'https://teams.microsoft.com/l/message/19%3Achannel%40thread.v2/1647012345678?tenantId=tenant-abc',
    );
  });

  it('supports personal conversation ids', () => {
    expect(
      buildTeamsMessagePermalink({
        conversationId: '19:channel@thread.v2',
        messageId: 'activity-2',
      }),
    ).toBe(
      'https://teams.microsoft.com/l/message/19%3Achannel%40thread.v2/activity-2',
    );
  });

  it('falls back to the bot personal-app deep link for a: personal conversations', () => {
    expect(
      buildTeamsMessagePermalink({
        conversationId: 'a:personal-conversation',
        messageId: 'activity-2',
        tenantId: 'tenant-abc',
        botAppId: 'bot-app-id',
      }),
    ).toBe('https://teams.microsoft.com/l/app/bot-app-id?tenantId=tenant-abc');
  });

  it('omits the tenantId query for personal-app fallback when no tenant is provided', () => {
    expect(
      buildTeamsMessagePermalink({
        conversationId: 'a:personal-conversation',
        messageId: 'activity-2',
        botAppId: 'bot-app-id',
      }),
    ).toBe('https://teams.microsoft.com/l/app/bot-app-id');
  });

  it('returns null for a personal conversation when no bot app id is available', () => {
    expect(
      buildTeamsMessagePermalink({
        conversationId: 'a:personal-conversation',
        messageId: 'activity-2',
      }),
    ).toBeNull();
  });

  it('returns null when the conversation id or message id is missing for a channel conversation', () => {
    expect(
      buildTeamsMessagePermalink({
        conversationId: '19:channel@thread.v2',
        messageId: '',
      }),
    ).toBeNull();
    expect(
      buildTeamsMessagePermalink({
        conversationId: null,
        messageId: '1647012345678',
      }),
    ).toBeNull();
  });
});
