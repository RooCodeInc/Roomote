import type { PutObjectCommand } from '@aws-sdk/client-s3';

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    R_JUDGMENT_CAPTURE: undefined as string | undefined,
    S3_BUCKET_ARTIFACTS: 'artifacts-test',
    S3_ENDPOINT: 'http://localhost:19000',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'k',
    S3_SECRET_ACCESS_KEY: 's',
  },
}));

vi.mock('@roomote/env', () => ({ Env: mockEnv }));

import {
  captureJudgment,
  isJudgmentCaptureEnabled,
  resetJudgmentCaptureWindow,
  scrubJudgmentState,
} from '../judgment-capture';

const questions = {
  urgent: { type: 'noul' as const, instructions: 'Is it urgent?' },
};

describe('judgment capture', () => {
  beforeEach(() => {
    resetJudgmentCaptureWindow();
    mockEnv.R_JUDGMENT_CAPTURE = 'on';
  });

  it('is off unless the deployment opts in', () => {
    mockEnv.R_JUDGMENT_CAPTURE = undefined;
    expect(isJudgmentCaptureEnabled()).toBe(false);
    mockEnv.R_JUDGMENT_CAPTURE = 'on';
    expect(isJudgmentCaptureEnabled()).toBe(true);
  });

  it('writes one scrubbed JSON object per decision to the capture prefix', async () => {
    const send = vi.fn(async (_command: PutObjectCommand) => ({}));

    await captureJudgment({
      answeredBy: 'typesafe',
      state: {
        request:
          'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 from bob@example.com',
        nested: [{ text: 'plain' }],
      },
      questions,
      answers: { urgent: { type: 'noul', noul: 0.9 } },
      send,
      now: () => Date.UTC(2026, 8, 22, 12, 0, 0),
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0] as PutObjectCommand;
    expect(command.input.Bucket).toBe('artifacts-test');
    expect(command.input.Key).toMatch(
      /^judgment-capture\/2026-09-22\/\d+-[0-9a-f-]{36}\.json$/,
    );
    const record = JSON.parse(String(command.input.Body)) as {
      version: number;
      answeredBy: string;
      state: { request: string; nested: Array<{ text: string }> };
      answers: Record<string, unknown>;
    };
    expect(record.version).toBe(1);
    expect(record.answeredBy).toBe('typesafe');
    expect(record.state.request).not.toContain('ghp_');
    expect(record.state.request).not.toContain('bob@example.com');
    expect(record.state.nested[0]!.text).toBe('plain');
    expect(record.answers).toEqual({ urgent: { type: 'noul', noul: 0.9 } });
  });

  it('never throws to the caller when the write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      captureJudgment({
        answeredBy: 'helper',
        state: 'hi',
        questions,
        answers: {},
        send: async () => {
          throw new Error('bucket unavailable');
        },
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('skips a record over the size cap', async () => {
    const send = vi.fn(async () => ({}));

    await captureJudgment({
      answeredBy: 'roomote',
      state: 'x'.repeat(300 * 1024),
      questions,
      answers: {},
      send,
    });

    expect(send).not.toHaveBeenCalled();
  });

  it('stops after the hourly cap and resumes in the next hour', async () => {
    const send = vi.fn(async () => ({}));
    let now = Date.UTC(2026, 8, 22, 12, 0, 0);
    const write = () =>
      captureJudgment({
        answeredBy: 'roomote',
        state: 'hi',
        questions,
        answers: {},
        send,
        now: () => now,
      });

    for (let i = 0; i < 601; i++) await write();
    expect(send).toHaveBeenCalledTimes(600);

    now += 60 * 60_000;
    await write();
    expect(send).toHaveBeenCalledTimes(601);
  });

  it('scrubs every string leaf and leaves structure alone', () => {
    expect(
      scrubJudgmentState({
        a: 'mail me at a@b.co',
        b: [1, true, null, { c: 'ok' }],
      }),
    ).toEqual({
      a: 'mail me at [email address]',
      b: [1, true, null, { c: 'ok' }],
    });
  });
});
