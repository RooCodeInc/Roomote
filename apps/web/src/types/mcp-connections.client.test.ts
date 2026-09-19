import { saveStripeConnectionSchema } from './mcp-connections';

describe('saveStripeConnectionSchema', () => {
  it('accepts and trims restricted API keys', () => {
    expect(
      saveStripeConnectionSchema.parse({ apiKey: '  rk_test_restricted  ' }),
    ).toEqual({ apiKey: 'rk_test_restricted' });
  });

  it('allows an empty value so edits can retain the stored key', () => {
    expect(saveStripeConnectionSchema.parse({ apiKey: '   ' })).toEqual({
      apiKey: '',
    });
  });

  it.each(['sk_test_unrestricted', 'sk_live_unrestricted', 'pk_test_public'])(
    'rejects non-restricted Stripe key %s',
    (apiKey) => {
      expect(() => saveStripeConnectionSchema.parse({ apiKey })).toThrow(
        'Use a Stripe restricted API key starting with rk_',
      );
    },
  );
});
