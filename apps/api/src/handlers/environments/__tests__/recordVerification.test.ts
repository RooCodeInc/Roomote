import { Hono } from 'hono';

import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../../mcp/middleware';
import {
  recordVerification,
  sanitizeVerificationError,
} from '../recordVerification';

const {
  mockTaskRunFindFirst,
  mockEnvironmentsFindFirst,
  mockRecordEnvironmentVerification,
} = vi.hoisted(() => ({
  mockTaskRunFindFirst: vi.fn(),
  mockEnvironmentsFindFirst: vi.fn().mockResolvedValue({ id: 'env-1' }),
  mockRecordEnvironmentVerification: vi
    .fn()
    .mockResolvedValue({ recorded: true }),
}));

vi.mock('@roomote/db/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...original,
    recordEnvironmentVerification: mockRecordEnvironmentVerification,
    db: {
      query: {
        taskRuns: { findFirst: mockTaskRunFindFirst },
        environments: { findFirst: mockEnvironmentsFindFirst },
      },
    },
  };
});

function createApp(authContext?: AuthTokenContext | RunTokenContext) {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    if (authContext) {
      c.set('authContext', authContext);
    }
    await next();
  });
  app.use('*', mcpAuthMiddleware);
  app.post('/environments/:id/verification', recordVerification);

  return app;
}

function runToken(): RunTokenContext {
  return {
    runId: 42,
    userId: 'user-1',
    principal: 'user',
    tokenType: 'run',
    version: 1,
  };
}

function verificationRequest(id: string, body: unknown): Request {
  return new Request(`http://localhost/environments/${id}/verification`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('recordVerification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnvironmentsFindFirst.mockResolvedValue({ id: 'env-1' });
    mockRecordEnvironmentVerification.mockResolvedValue({ recorded: true });
  });

  it('records a successful verification for a task marked to verify the environment', async () => {
    mockTaskRunFindFirst.mockResolvedValueOnce({
      taskId: 'task-abc',
      payload: { verifiesEnvironmentId: 'env-1' },
    });

    const app = createApp(runToken());
    const response = await app.request(
      verificationRequest('env-1', { success: true }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      environmentId: 'env-1',
      isVerified: true,
    });
    expect(mockRecordEnvironmentVerification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environmentId: 'env-1',
        verificationTaskId: 'task-abc',
        success: true,
      }),
    );
  });

  it('authorizes the environment-setup task via the environmentDefinitionId marker', async () => {
    mockTaskRunFindFirst.mockResolvedValueOnce({
      taskId: 'task-setup',
      payload: { environmentDefinitionId: 'env-1' },
    });

    const app = createApp(runToken());
    const response = await app.request(
      verificationRequest('env-1', { success: false, error: 'boot failed' }),
    );

    expect(response.status).toBe(200);
    expect(mockRecordEnvironmentVerification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        verificationTaskId: 'task-setup',
        success: false,
        error: 'boot failed',
      }),
    );
  });

  it('rejects a task that is not authorized for the target environment', async () => {
    mockTaskRunFindFirst.mockResolvedValueOnce({
      taskId: 'task-other',
      payload: { verifiesEnvironmentId: 'env-other' },
    });

    const app = createApp(runToken());
    const response = await app.request(
      verificationRequest('env-1', { success: true }),
    );

    expect(response.status).toBe(403);
    expect(mockRecordEnvironmentVerification).not.toHaveBeenCalled();
  });

  it('rejects a user auth token with no run binding', async () => {
    const authContext: AuthTokenContext = {
      userId: 'user-1',
      tokenType: 'auth',
      version: 1,
    };

    const app = createApp(authContext);
    const response = await app.request(
      verificationRequest('env-1', { success: true }),
    );

    expect(response.status).toBe(403);
    expect(mockRecordEnvironmentVerification).not.toHaveBeenCalled();
  });

  it('returns 409 when the verification attempt is superseded', async () => {
    mockTaskRunFindFirst.mockResolvedValueOnce({
      taskId: 'task-stale',
      payload: { verifiesEnvironmentId: 'env-1' },
    });
    mockRecordEnvironmentVerification.mockResolvedValueOnce({
      recorded: false,
    });

    const app = createApp(runToken());
    const response = await app.request(
      verificationRequest('env-1', { success: true }),
    );

    expect(response.status).toBe(409);
  });

  it('requires a boolean success field', async () => {
    const app = createApp(runToken());
    const response = await app.request(
      verificationRequest('env-1', { error: 'nope' }),
    );

    expect(response.status).toBe(400);
  });
});

describe('sanitizeVerificationError', () => {
  it('strips secret-looking assignment lines', () => {
    const result = sanitizeVerificationError(
      'Startup failed.\nAPI_KEY=super-secret-value\nexport DB_PASSWORD: hunter2',
    );

    expect(result).toBe('Startup failed.');
  });

  it('strips lowercase and YAML-style secret lines', () => {
    const result = sanitizeVerificationError(
      'Could not boot.\ndatabase_url: postgres://user:pw@host/db\n- token: abc123',
    );

    expect(result).toBe('Could not boot.');
  });

  it('collapses whitespace and returns null for non-strings', () => {
    expect(sanitizeVerificationError('  boot   failed  ')).toBe('boot failed');
    expect(sanitizeVerificationError(undefined)).toBeNull();
    expect(sanitizeVerificationError(123)).toBeNull();
  });
});
