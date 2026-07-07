import { verifyAdoWebhook } from '../verifyWebhook';

describe('verifyAdoWebhook', () => {
  it('accepts the custom Roomote webhook secret header', () => {
    expect(
      verifyAdoWebhook({
        headers: {
          'x-roomote-webhook-secret': 'secret',
        },
        secretToken: 'secret',
      }),
    ).toBe(true);
  });

  it('accepts the Basic auth password configured on the ADO service hook', () => {
    expect(
      verifyAdoWebhook({
        headers: {
          authorization: `Basic ${Buffer.from('roomote:secret').toString(
            'base64',
          )}`,
        },
        secretToken: 'secret',
      }),
    ).toBe(true);
  });

  it('rejects missing or mismatched secrets', () => {
    expect(
      verifyAdoWebhook({
        headers: {
          'x-roomote-webhook-secret': 'bad',
        },
        secretToken: 'secret',
      }),
    ).toBe(false);

    expect(
      verifyAdoWebhook({
        headers: {},
        secretToken: 'secret',
      }),
    ).toBe(false);
  });
});
