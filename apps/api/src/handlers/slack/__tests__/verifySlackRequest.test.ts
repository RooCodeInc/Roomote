// pnpm test src/handlers/slack/__tests__/verifySlackRequest.test.ts

import { createHmac } from 'node:crypto';

import { verifySlackRequest } from '../verifySlackRequest';

describe('verifySlackRequest', () => {
  const mockSigningSecret = 'test_signing_secret_123';
  const mockTimestamp = '1609459200'; // 2021-01-01 00:00:00 UTC
  const mockBody = '{"type":"url_verification","challenge":"test_challenge"}';

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock current time to be within 5 minutes of mock timestamp.
    vi.spyOn(Date, 'now').mockReturnValue(1609459200000 + 60000); // 1 minute later.
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createValidSignature(
    timestamp: string,
    body: string,
    secret: string,
  ): string {
    const basestring = `v0:${timestamp}:${body}`;
    const signature = createHmac('sha256', secret)
      .update(basestring, 'utf8')
      .digest('hex');
    return `v0=${signature}`;
  }

  it('should return valid for correct signature and timestamp', () => {
    const signature = createValidSignature(
      mockTimestamp,
      mockBody,
      mockSigningSecret,
    );

    const result = verifySlackRequest(
      signature,
      mockTimestamp,
      mockBody,
      mockSigningSecret,
    );

    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return invalid for missing signature header', () => {
    const result = verifySlackRequest(
      undefined,
      mockTimestamp,
      mockBody,
      mockSigningSecret,
    );

    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Missing X-Slack-Signature header');
  });

  it('should return invalid for missing timestamp header', () => {
    const signature = createValidSignature(
      mockTimestamp,
      mockBody,
      mockSigningSecret,
    );

    const result = verifySlackRequest(
      signature,
      undefined,
      mockBody,
      mockSigningSecret,
    );

    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Missing X-Slack-Request-Timestamp header');
  });

  it('should return invalid for incorrect signature format', () => {
    const result = verifySlackRequest(
      'invalid_format',
      mockTimestamp,
      mockBody,
      mockSigningSecret,
    );

    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Invalid signature format');
  });

  it('should return invalid for invalid timestamp format', () => {
    const signature = createValidSignature(
      mockTimestamp,
      mockBody,
      mockSigningSecret,
    );

    const result = verifySlackRequest(
      signature,
      'invalid_timestamp',
      mockBody,
      mockSigningSecret,
    );

    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Invalid timestamp format');
  });

  it('should return invalid for old timestamp (replay attack)', () => {
    const oldTimestamp = '1609459200'; // Mock current time is much later
    vi.spyOn(Date, 'now').mockReturnValue(1609459200000 + 400000); // 400 seconds later (> 300s limit)

    const signature = createValidSignature(
      oldTimestamp,
      mockBody,
      mockSigningSecret,
    );

    const result = verifySlackRequest(
      signature,
      oldTimestamp,
      mockBody,
      mockSigningSecret,
    );

    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Request timestamp too old');
  });

  it('should return invalid for incorrect signature', () => {
    const wrongSecret = 'wrong_secret';

    const signature = createValidSignature(
      mockTimestamp,
      mockBody,
      wrongSecret,
    );

    const result = verifySlackRequest(
      signature,
      mockTimestamp,
      mockBody,
      mockSigningSecret,
    );

    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Signature verification failed');
  });

  it('should return invalid for tampered body', () => {
    const signature = createValidSignature(
      mockTimestamp,
      mockBody,
      mockSigningSecret,
    );
    const tamperedBody = mockBody + '_tampered';

    const result = verifySlackRequest(
      signature,
      mockTimestamp,
      tamperedBody,
      mockSigningSecret,
    );

    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Signature verification failed');
  });
});
