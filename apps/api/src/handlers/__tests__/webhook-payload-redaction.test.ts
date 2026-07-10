import {
  isSensitiveWebhookPayloadKey,
  redactWebhookPayload,
} from '../webhook-payload-redaction';

describe('isSensitiveWebhookPayloadKey', () => {
  it.each([
    'secret',
    'token',
    'password',
    'credentials',
    'authorization',
    'api_key',
    'apiKey',
    'private_key',
    'client_secret',
    'clientSecret',
    'webhook_secret',
    'access_token',
    'accessToken',
    'refresh_token',
    'id_token',
    'auth-token',
    'SECRET_TOKEN',
  ])('flags %s', (key) => {
    expect(isSensitiveWebhookPayloadKey(key)).toBe(true);
  });

  it.each([
    'body',
    'description',
    'title',
    'email',
    'login',
    'full_name',
    'html_url',
    'action',
    'tokenizer', // 'token' must match as a whole segment, not a prefix.
    'secretary',
  ])('keeps %s', (key) => {
    expect(isSensitiveWebhookPayloadKey(key)).toBe(false);
  });
});

describe('redactWebhookPayload', () => {
  it('masks sensitive keys at any depth and preserves everything else', () => {
    const payload = {
      action: 'created',
      hook: {
        id: 42,
        config: {
          url: 'https://example.com/webhook',
          secret: 'hunter2',
          insecure_ssl: '0',
        },
      },
      installation: { id: 7 },
      sender: { login: 'octocat', email: 'octo@example.com' },
      items: [{ access_token: 'abc123' }, { note: 'keep me' }],
    };

    expect(redactWebhookPayload(payload)).toEqual({
      action: 'created',
      hook: {
        id: 42,
        config: {
          url: 'https://example.com/webhook',
          secret: '[REDACTED]',
          insecure_ssl: '0',
        },
      },
      installation: { id: 7 },
      sender: { login: 'octocat', email: 'octo@example.com' },
      items: [{ access_token: '[REDACTED]' }, { note: 'keep me' }],
    });
  });

  it('redacts non-string secret values, including nested objects', () => {
    expect(
      redactWebhookPayload({
        credentials: { user: 'u', pass: 'p' },
        token: 12345,
      }),
    ).toEqual({ credentials: '[REDACTED]', token: '[REDACTED]' });
  });

  it('keeps null secret values as null', () => {
    expect(redactWebhookPayload({ secret: null })).toEqual({ secret: null });
  });

  it('does not mutate the original payload', () => {
    const payload = { config: { secret: 'hunter2' } };

    redactWebhookPayload(payload);

    expect(payload.config.secret).toBe('hunter2');
  });

  it('passes through non-object payloads', () => {
    expect(redactWebhookPayload('raw-body')).toBe('raw-body');
    expect(redactWebhookPayload(null)).toBeNull();
  });
});
