import {
  createDiagnosticEventRecorder,
  redactSecrets,
} from '../diagnostic-events';

const { mockRecordEvent } = vi.hoisted(() => ({
  mockRecordEvent: vi.fn(async (_options: unknown) => undefined),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      recordEvent: mockRecordEvent,
    },
  },
}));

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('redactSecrets', () => {
  it('redacts provider keys, bearer headers, and JWTs', () => {
    const input = [
      'openai key sk-abc123def456ghi789 leaked',
      'github ghp_ABCdef123456789012345678901234567890',
      'slack xoxb-1234567890-abcdefghijklmnop',
      'Authorization: Bearer abcDEF123456789.token-value',
      'Authorization: Basic dXNlcjpwYXNz',
      'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c',
    ].join('\n');

    const output = redactSecrets(input);

    expect(output).not.toContain('sk-abc123def456ghi789');
    expect(output).not.toContain('ghp_ABCdef');
    expect(output).not.toContain('xoxb-1234567890');
    expect(output).not.toContain('abcDEF123456789.token-value');
    expect(output).not.toContain('dXNlcjpwYXNz');
    expect(output).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(output).toContain('[redacted]');
  });

  it('redacts credential-shaped assignments while keeping the key name', () => {
    const output = redactSecrets('DATABASE_PASSWORD=hunter2 api_key: 12345');

    expect(output).toContain('PASSWORD=[redacted]');
    expect(output).not.toContain('hunter2');
    expect(output).toContain('api_key: [redacted]');
  });

  it('keeps an identifying prefix on hash-shaped values', () => {
    const sha = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
    const output = redactSecrets(`checked out commit ${sha}`);

    expect(output).toContain('a1b2c3d4…[redacted]');
    expect(output).not.toContain(sha);
  });

  it('leaves ordinary log text alone', () => {
    const text =
      'OpenCode server exited with code 137 after 512s; last request POST /session/prompt';

    expect(redactSecrets(text)).toBe(text);
  });
});

describe('createDiagnosticEventRecorder', () => {
  beforeEach(() => {
    mockRecordEvent.mockClear();
    mockRecordEvent.mockResolvedValue(undefined);
  });

  it('records a scrubbed, capped diagnostic run event', () => {
    const recorder = createDiagnosticEventRecorder({
      runId: 7,
      logger: createLogger(),
    });

    recorder.record({
      kind: 'harness_exit',
      message: 'exited with token sk-abc123def456ghi789',
      details: {
        exitCode: 137,
        stderrTail: 'x'.repeat(5_000),
      },
    });

    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
    const call = mockRecordEvent.mock.calls[0]?.[0] as {
      runId: number;
      source: string;
      eventType: string;
      message: string;
      details: Record<string, unknown>;
    };
    expect(call.runId).toBe(7);
    expect(call.source).toBe('worker_runtime');
    expect(call.eventType).toBe('diagnostic');
    expect(call.message).not.toContain('sk-abc123def456ghi789');
    expect(call.details.kind).toBe('harness_exit');
    expect(call.details.exitCode).toBe(137);
    expect((call.details.stderrTail as string).length).toBeLessThan(4_100);
    expect(call.details.stderrTail as string).toContain('[truncated]');
  });

  it('does not let caller details override the recorder kind', () => {
    const recorder = createDiagnosticEventRecorder({
      runId: 7,
      logger: createLogger(),
    });

    recorder.record({
      kind: 'harness_exit',
      message: 'ok',
      details: { kind: 'spoofed' },
    });

    const call = mockRecordEvent.mock.calls[0]?.[0] as {
      details: Record<string, unknown>;
    };
    expect(call.details.kind).toBe('harness_exit');
  });

  it('never throws when persistence fails', async () => {
    const logger = createLogger();
    mockRecordEvent.mockRejectedValueOnce(new Error('api unreachable'));

    const recorder = createDiagnosticEventRecorder({ runId: 7, logger });

    expect(() =>
      recorder.record({ kind: 'harness_exit', message: 'boom' }),
    ).not.toThrow();

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to record harness_exit'),
      );
    });
  });

  it('never throws when the details are unserializable-shaped', () => {
    const recorder = createDiagnosticEventRecorder({
      runId: 7,
      logger: createLogger(),
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() =>
      recorder.record({ kind: 'weird', message: 'ok', details: cyclic }),
    ).not.toThrow();
  });
});
