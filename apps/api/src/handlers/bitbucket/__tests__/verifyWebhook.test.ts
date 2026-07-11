import { createHmac } from 'node:crypto';

import { verifyBitbucketWebhook } from '../verifyWebhook';

describe('verifyBitbucketWebhook', () => {
  it('accepts x-hub-signature-256', () => {
    const body = JSON.stringify({ pullrequest: { id: 1 } });
    const signature = createHmac('sha256', 'secret').update(body).digest('hex');

    expect(
      verifyBitbucketWebhook({
        body,
        headers: {
          'x-hub-signature-256': `sha256=${signature}`,
        },
        secretToken: 'secret',
      }),
    ).toBe(true);
  });

  it('accepts bare hex x-hub-signature', () => {
    const body = JSON.stringify({ pullrequest: { id: 1 } });
    const signature = createHmac('sha256', 'secret').update(body).digest('hex');

    expect(
      verifyBitbucketWebhook({
        body,
        headers: {
          'x-hub-signature': signature,
        },
        secretToken: 'secret',
      }),
    ).toBe(true);
  });

  it('rejects missing secret or mismatched signatures', () => {
    expect(
      verifyBitbucketWebhook({
        body: '{}',
        headers: {
          'x-hub-signature': 'bad',
        },
        secretToken: 'secret',
      }),
    ).toBe(false);

    expect(
      verifyBitbucketWebhook({
        body: '{}',
        headers: {},
        secretToken: undefined,
      }),
    ).toBe(false);
  });
});
