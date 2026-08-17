import { SLACK_MANIFEST_BOT_SCOPES } from './slack-app-manifest';
import { buildSlackInstallUrl } from './slack-install-url';

describe('Slack install URL builder', () => {
  it('requests the same bot scopes as the generated app manifest', () => {
    const url = new URL(
      buildSlackInstallUrl({
        clientId: 'client-id',
        state: 'signed-state',
        redirectUri: 'https://roomote.example.com/api/slack/callback',
      }),
    );

    expect(url.searchParams.get('scope')?.split(',')).toEqual([
      ...SLACK_MANIFEST_BOT_SCOPES,
    ]);
    expect(url.searchParams.get('scope')?.split(',')).toContain(
      'assistant:write',
    );
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://roomote.example.com/api/slack/callback',
    );
  });
});
