vi.mock('../../config', () => ({
  config: {
    NODE_ENV: 'test',
  },
}));

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  escapeForLog: (s: string) => s,
}));

vi.mock('../../services/resolver', () => ({
  resolveRequest: vi.fn(),
}));

// Use the real url-parser — no mock needed
import { tryNestedFallback } from '../nested-routing';
import { resolveRequest } from '../../services/resolver';
import { logger } from '../logger';

describe('tryNestedFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null for non-nested hosts', async () => {
    const host = '550e8400-e29b-41d4-a716-446655440000-web.preview.roomote.run';

    const result = await tryNestedFallback(host);

    expect(result).toBeNull();
    expect(resolveRequest).not.toHaveBeenCalled();
  });

  it('should return resolution when nested URL matches active wildcard port', async () => {
    const innerTaskId = '3579x1khed4zp';
    const outerTaskId = '20imtw24sm6hv';
    const host = `${innerTaskId}-web-${outerTaskId}-preview.preview.roomote.run`;

    const mockResolution = {
      status: 'active' as const,
      sandboxUrl: 'http://sandbox.example.com:3000',
      wildcardPrefix: true,
      taskRun: null,
      requiresAuth: false,
      hasAuthProxy: false,
    };
    vi.mocked(resolveRequest).mockResolvedValue(mockResolution);

    const result = await tryNestedFallback(host, 'HTTP');

    expect(result).toBe(mockResolution);
    expect(resolveRequest).toHaveBeenCalledWith(
      { taskId: outerTaskId },
      'preview',
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        outerPortName: 'preview',
        innerPrefix: `${innerTaskId}-web`,
      }),
      'HTTP: Nested URL: routing to outer sandbox via wildcard port',
    );
  });

  it('should return null when outer port is not active', async () => {
    const innerTaskId = '3579x1khed4zp';
    const outerTaskId = '20imtw24sm6hv';
    const host = `${innerTaskId}-web-${outerTaskId}-preview.preview.roomote.run`;

    vi.mocked(resolveRequest).mockResolvedValue({
      status: 'not_found',
      taskRun: null,
      requiresAuth: false,
      hasAuthProxy: false,
    });

    const result = await tryNestedFallback(host);

    expect(result).toBeNull();
  });

  it('should return null when outer port does not have wildcard_prefix', async () => {
    const innerTaskId = '3579x1khed4zp';
    const outerTaskId = '20imtw24sm6hv';
    const host = `${innerTaskId}-web-${outerTaskId}-preview.preview.roomote.run`;

    vi.mocked(resolveRequest).mockResolvedValue({
      status: 'active',
      sandboxUrl: 'http://sandbox.example.com:3000',
      wildcardPrefix: false,
      taskRun: null,
      requiresAuth: false,
      hasAuthProxy: false,
    });

    const result = await tryNestedFallback(host);

    expect(result).toBeNull();
  });

  it('should use logContext in log message when provided', async () => {
    const innerTaskId = '3579x1khed4zp';
    const outerTaskId = '20imtw24sm6hv';
    const host = `${innerTaskId}-web-${outerTaskId}-preview.preview.roomote.run`;

    vi.mocked(resolveRequest).mockResolvedValue({
      status: 'active',
      sandboxUrl: 'http://sandbox.example.com:3000',
      wildcardPrefix: true,
      taskRun: null,
      requiresAuth: false,
      hasAuthProxy: false,
    });

    await tryNestedFallback(host, 'WebSocket');

    expect(logger.info).toHaveBeenCalledWith(
      expect.anything(),
      'WebSocket: Nested URL: routing to outer sandbox via wildcard port',
    );
  });

  it('should omit logContext prefix when not provided', async () => {
    const innerTaskId = '3579x1khed4zp';
    const outerTaskId = '20imtw24sm6hv';
    const host = `${innerTaskId}-web-${outerTaskId}-preview.preview.roomote.run`;

    vi.mocked(resolveRequest).mockResolvedValue({
      status: 'active',
      sandboxUrl: 'http://sandbox.example.com:3000',
      wildcardPrefix: true,
      taskRun: null,
      requiresAuth: false,
      hasAuthProxy: false,
    });

    await tryNestedFallback(host);

    expect(logger.info).toHaveBeenCalledWith(
      expect.anything(),
      'Nested URL: routing to outer sandbox via wildcard port',
    );
  });
});
