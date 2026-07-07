import { createHmac } from 'node:crypto';

import { verifyGiteaWebhook } from '../verifyWebhook';

describe('verifyGiteaWebhook', () => {
  it('accepts the Gitea HMAC-SHA256 signature header', () => {
    const body = JSON.stringify({ action: 'opened' });
    const signature = createHmac('sha256', 'secret').update(body).digest('hex');

    expect(
      verifyGiteaWebhook({
        body,
        headers: {
          'x-gitea-signature': signature,
        },
        secretToken: 'secret',
      }),
    ).toBe(true);
  });

  it('accepts the GitHub-compatible SHA256 signature header', () => {
    const body = JSON.stringify({ action: 'opened' });
    const signature = createHmac('sha256', 'secret').update(body).digest('hex');

    expect(
      verifyGiteaWebhook({
        body,
        headers: {
          'x-hub-signature-256': `sha256=${signature}`,
        },
        secretToken: 'secret',
      }),
    ).toBe(true);
  });

  it('rejects missing or mismatched signatures', () => {
    expect(
      verifyGiteaWebhook({
        body: '{}',
        headers: {
          'x-gitea-signature': 'bad',
        },
        secretToken: 'secret',
      }),
    ).toBe(false);

    expect(
      verifyGiteaWebhook({
        body: '{}',
        headers: {},
        secretToken: 'secret',
      }),
    ).toBe(false);
  });
});
