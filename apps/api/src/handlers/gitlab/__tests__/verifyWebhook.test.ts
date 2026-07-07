import { createHmac } from 'node:crypto';

import { verifyGitLabWebhook } from '../verifyWebhook';

describe('verifyGitLabWebhook', () => {
  it('accepts the legacy GitLab secret token header', () => {
    expect(
      verifyGitLabWebhook({
        body: '{"ok":true}',
        headers: {
          'x-gitlab-token': 'secret',
        },
        secretToken: 'secret',
      }),
    ).toBe(true);
  });

  it('accepts a valid GitLab signing token signature', () => {
    const body = '{"ok":true}';
    const signingToken = `whsec_${Buffer.from('01234567890123456789012345678901').toString('base64')}`;
    const messageId = 'msg-1';
    const timestamp = '1782676000';
    const signature = `v1,${createHmac(
      'sha256',
      Buffer.from(signingToken.replace(/^whsec_/, ''), 'base64'),
    )
      .update(`${messageId}.${timestamp}.${body}`)
      .digest('base64')}`;

    expect(
      verifyGitLabWebhook({
        body,
        headers: {
          'webhook-id': messageId,
          'webhook-timestamp': timestamp,
          'webhook-signature': signature,
        },
        now: new Date(Number(timestamp) * 1000),
        signingToken,
      }),
    ).toBe(true);
  });

  it('rejects stale signing token timestamps', () => {
    expect(
      verifyGitLabWebhook({
        body: '{"ok":true}',
        headers: {
          'webhook-id': 'msg-1',
          'webhook-timestamp': '1782676000',
          'webhook-signature': 'v1,invalid',
        },
        now: new Date((1782676000 + 600) * 1000),
        signingToken: `whsec_${Buffer.from('01234567890123456789012345678901').toString('base64')}`,
      }),
    ).toBe(false);
  });
});
