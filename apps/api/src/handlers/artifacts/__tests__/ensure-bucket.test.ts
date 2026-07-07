import type { S3Client } from '@aws-sdk/client-s3';

import {
  ensureArtifactsBucketAtBoot,
  isAutoCreateBucketEnabled,
} from '../ensure-bucket';

function namedError(name: string, statusCode?: number): Error {
  const error = new Error(name);
  error.name = name;
  if (statusCode !== undefined) {
    Object.assign(error, { $metadata: { httpStatusCode: statusCode } });
  }
  return error;
}

function stubClient(send: ReturnType<typeof vi.fn>): S3Client {
  return { send, destroy: vi.fn() } as unknown as S3Client;
}

describe('isAutoCreateBucketEnabled', () => {
  it('accepts true and 1 with surrounding whitespace and any case', () => {
    expect(isAutoCreateBucketEnabled('true')).toBe(true);
    expect(isAutoCreateBucketEnabled(' TRUE ')).toBe(true);
    expect(isAutoCreateBucketEnabled('1')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isAutoCreateBucketEnabled(undefined)).toBe(false);
    expect(isAutoCreateBucketEnabled('')).toBe(false);
    expect(isAutoCreateBucketEnabled('false')).toBe(false);
    expect(isAutoCreateBucketEnabled('yes')).toBe(false);
  });
});

describe('ensureArtifactsBucketAtBoot', () => {
  it('does nothing when disabled', async () => {
    const send = vi.fn();

    await ensureArtifactsBucketAtBoot({
      enabled: false,
      client: stubClient(send),
    });

    expect(send).not.toHaveBeenCalled();
  });

  it('leaves an existing bucket alone', async () => {
    const send = vi.fn().mockResolvedValue({});
    const log = vi.fn();

    await ensureArtifactsBucketAtBoot({
      enabled: true,
      bucket: 'artifacts',
      client: stubClient(send),
      log,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].constructor.name).toBe('HeadBucketCommand');
    expect(log).not.toHaveBeenCalled();
  });

  it('creates the bucket when the head check reports it missing', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(namedError('NotFound', 404))
      .mockResolvedValueOnce({});
    const log = vi.fn();

    await ensureArtifactsBucketAtBoot({
      enabled: true,
      bucket: 'artifacts',
      client: stubClient(send),
      log,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].constructor.name).toBe('CreateBucketCommand');
    expect(log).toHaveBeenCalledWith(
      '[artifacts-bucket] Created S3 bucket "artifacts".',
    );
  });

  it('tolerates losing a creation race', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(namedError('NotFound', 404))
      .mockRejectedValueOnce(namedError('BucketAlreadyOwnedByYou', 409));
    const warn = vi.fn();

    await ensureArtifactsBucketAtBoot({
      enabled: true,
      bucket: 'artifacts',
      client: stubClient(send),
      warn,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it('retries connection failures before warning without throwing', async () => {
    const send = vi.fn().mockRejectedValue(namedError('ECONNREFUSED'));
    const warn = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    await ensureArtifactsBucketAtBoot({
      enabled: true,
      bucket: 'artifacts',
      client: stubClient(send),
      retryDelaysMs: [1, 2],
      warn,
      sleep,
    });

    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('artifacts');
  });

  it('warns immediately on permission errors instead of retrying', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(namedError('NotFound', 404))
      .mockRejectedValue(namedError('AccessDenied', 403));
    const warn = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    await ensureArtifactsBucketAtBoot({
      enabled: true,
      bucket: 'artifacts',
      client: stubClient(send),
      retryDelaysMs: [1, 2],
      warn,
      sleep,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries 5xx responses from a store that is still booting', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(namedError('ServiceUnavailable', 503))
      .mockResolvedValueOnce({});
    const warn = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    await ensureArtifactsBucketAtBoot({
      enabled: true,
      bucket: 'artifacts',
      client: stubClient(send),
      retryDelaysMs: [1, 2],
      warn,
      sleep,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
