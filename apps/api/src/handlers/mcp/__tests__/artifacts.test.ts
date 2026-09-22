import { Hono } from 'hono';

import type { McpAuth } from '../middleware';
import type { Variables } from '../../../types';

const {
  mockTaskFindFirst,
  mockTaskRunFindFirst,
  mockSessionFindFirst,
  mockGetTaskArtifactByPath,
  mockGetSessionArtifactByPath,
  mockGetArtifactObject,
  mockVerifyTaskReadAccess,
} = vi.hoisted(() => ({
  mockTaskFindFirst: vi.fn(),
  mockTaskRunFindFirst: vi.fn(),
  mockSessionFindFirst: vi.fn(),
  mockGetTaskArtifactByPath: vi.fn(),
  mockGetSessionArtifactByPath: vi.fn(),
  mockGetArtifactObject: vi.fn(),
  mockVerifyTaskReadAccess: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args) => ({ type: 'and', args })),
  db: {
    query: {
      tasks: { findFirst: mockTaskFindFirst },
      taskRuns: { findFirst: mockTaskRunFindFirst },
      sessions: { findFirst: mockSessionFindFirst },
    },
  },
  eq: vi.fn((...args) => ({ type: 'eq', args })),
  getSessionArtifactByPath: mockGetSessionArtifactByPath,
  getTaskArtifactByPath: mockGetTaskArtifactByPath,
  isVisibleTask: vi.fn(() => ({ type: 'visible' })),
  sessions: { id: 'sessions.id', visibility: 'sessions.visibility' },
  taskRuns: { id: 'taskRuns.id' },
  tasks: { id: 'tasks.id' },
}));

vi.mock('../../custom-automation-history-access', () => ({
  customAutomationHistoryAccess: vi.fn(() => ({ type: 'history-access' })),
}));

vi.mock('../../artifacts/auth', () => ({
  verifyArtifactRouteTaskReadAccess: mockVerifyTaskReadAccess,
}));

vi.mock('../../artifacts/storage', () => ({
  getArtifactObject: mockGetArtifactObject,
}));

import { artifactMcpRouter } from '../artifacts';

const auth: McpAuth = {
  userId: 'user-1',
  authContext: { userId: 'user-1', tokenType: 'auth', version: 1 },
};

function app(mcpAuth: McpAuth = auth) {
  const app = new Hono<{
    Variables: Variables & { mcpAuth: McpAuth };
  }>();
  app.use('*', async (c, next) => {
    c.set('mcpAuth', mcpAuth);
    await next();
  });
  app.route('/artifacts', artifactMcpRouter);
  return app;
}

function textArtifact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'artifact-1',
    taskId: 'task-1',
    sessionId: null,
    path: 'plans/summary.md',
    version: 2,
    artifactType: 'plan',
    contentType: 'text/markdown',
    size: 12,
    uploaded: true,
    ...overrides,
  };
}

function textBody(content: string) {
  const bytes = new TextEncoder().encode(content);
  return {
    transformToWebStream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTaskFindFirst.mockResolvedValue({ id: 'task-1' });
  mockTaskRunFindFirst.mockResolvedValue({ taskId: 'task-1' });
  mockSessionFindFirst.mockResolvedValue({ id: 'session-1' });
  mockVerifyTaskReadAccess.mockResolvedValue({ ok: true });
  mockGetTaskArtifactByPath.mockResolvedValue(textArtifact());
  mockGetSessionArtifactByPath.mockResolvedValue(
    textArtifact({
      id: 'session-artifact-1',
      taskId: null,
      sessionId: 'session-1',
      path: 'notes/context.md',
      version: 1,
    }),
  );
  mockGetArtifactObject.mockResolvedValue({
    Body: textBody('artifact text'),
    ContentLength: 12,
  });
});

it('opens an authorized task artifact and returns bounded text content', async () => {
  const response = await app().request('/artifacts/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'task-1', path: 'plans/summary.md' }),
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    id: 'artifact-1',
    taskId: 'task-1',
    path: 'plans/summary.md',
    version: 2,
    content: 'artifact text',
  });
  expect(mockGetArtifactObject).toHaveBeenCalledWith(
    { taskId: 'task-1' },
    'artifact-1',
    'plans/summary.md',
    2,
  );
});

it('preserves significant whitespace in the stored artifact path', async () => {
  const path = 'plans/summary.md ';
  mockGetTaskArtifactByPath.mockResolvedValueOnce(
    textArtifact({ path, version: 3 }),
  );

  const response = await app().request('/artifacts/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'task-1', path }),
  });

  expect(response.status).toBe(200);
  expect(mockGetTaskArtifactByPath).toHaveBeenCalledWith({
    taskId: 'task-1',
    path,
    version: undefined,
  });
});

it('opens a Session artifact only through the authorized Session owner', async () => {
  const response = await app().request('/artifacts/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-1', path: 'notes/context.md' }),
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    id: 'session-artifact-1',
    taskId: null,
    sessionId: 'session-1',
    content: 'artifact text',
  });
  expect(mockGetArtifactObject).toHaveBeenCalledWith(
    { sessionId: 'session-1' },
    'session-artifact-1',
    'notes/context.md',
    1,
  );
});

it('fails closed before artifact lookup when task access is denied', async () => {
  mockTaskFindFirst.mockResolvedValueOnce(undefined);

  const response = await app().request('/artifacts/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'private-task', path: 'secret.txt' }),
  });

  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({
    error: 'Artifact access denied',
  });
  expect(mockGetTaskArtifactByPath).not.toHaveBeenCalled();
  expect(mockGetArtifactObject).not.toHaveBeenCalled();
});

it('uses run-token task binding for task reads', async () => {
  mockVerifyTaskReadAccess.mockResolvedValueOnce({
    ok: false,
    status: 403,
    error: 'Task run token does not grant read access to requested task',
  });

  const response = await app({
    userId: 'user-1',
    authContext: {
      userId: 'user-1',
      runId: 7,
      principal: 'user',
      tokenType: 'run',
      version: 1,
    },
  }).request('/artifacts/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'other-task', path: 'notes.txt' }),
  });

  expect(response.status).toBe(403);
  expect(mockVerifyTaskReadAccess).toHaveBeenCalledWith(
    'other-task',
    expect.objectContaining({ runId: 7 }),
  );
  expect(mockGetTaskArtifactByPath).not.toHaveBeenCalled();
});

it('defaults a run-token call to its bound current task', async () => {
  const response = await app({
    userId: 'user-1',
    authContext: {
      userId: 'user-1',
      runId: 7,
      principal: 'user',
      tokenType: 'run',
      version: 1,
    },
  }).request('/artifacts/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'plans/summary.md' }),
  });

  expect(response.status).toBe(200);
  expect(mockGetTaskArtifactByPath).toHaveBeenCalledWith(
    expect.objectContaining({ taskId: 'task-1', path: 'plans/summary.md' }),
  );
});

it('returns explicit errors for missing, unsupported, and oversized artifacts', async () => {
  mockGetTaskArtifactByPath.mockResolvedValueOnce(null);
  const missing = await app().request('/artifacts/open', {
    method: 'POST',
    body: JSON.stringify({ taskId: 'task-1', path: 'missing.txt' }),
  });
  expect(missing.status).toBe(404);

  mockGetTaskArtifactByPath.mockResolvedValueOnce(
    textArtifact({ contentType: 'application/pdf' }),
  );
  const unsupported = await app().request('/artifacts/open', {
    method: 'POST',
    body: JSON.stringify({ taskId: 'task-1', path: 'report.pdf' }),
  });
  expect(unsupported.status).toBe(415);
  await expect(unsupported.json()).resolves.toMatchObject({
    error: 'Artifact format is not supported by open_artifact',
  });

  mockGetTaskArtifactByPath.mockResolvedValueOnce(
    textArtifact({ size: 1024 * 1024 + 1 }),
  );
  const oversized = await app().request('/artifacts/open', {
    method: 'POST',
    body: JSON.stringify({ taskId: 'task-1', path: 'large.txt' }),
  });
  expect(oversized.status).toBe(413);
  await expect(oversized.json()).resolves.toMatchObject({
    error: 'Artifact is too large to open',
    maxBytes: 1024 * 1024,
  });
  expect(mockGetArtifactObject).not.toHaveBeenCalled();
});
