import type { AuthTokenContext } from '@roomote/types';

const { envState, findConnectionMock, getValidAccessTokenMock } = vi.hoisted(
  () => ({
    envState: { R_CURATED_INTEGRATIONS_DISABLED: false },
    findConnectionMock: vi.fn(),
    getValidAccessTokenMock: vi.fn(),
  }),
);

vi.mock('@roomote/env', () => ({
  Env: envState,
  areCuratedIntegrationsDisabled: (value: boolean | undefined) =>
    value === true,
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: { taskRuns: { findFirst: vi.fn() } } },
  taskRuns: { id: 'taskRuns.id' },
  eq: vi.fn(),
}));

vi.mock('@roomote/linear', () => ({
  createLinearClient: vi.fn(),
  drainLinearMessagesToResumeRun: vi.fn(),
}));

vi.mock('../lib/mcp/data', () => ({
  getValidAccessToken: getValidAccessTokenMock,
}));

vi.mock('../lib/mcp/linear-connections', () => ({
  findLinearDeploymentMcpConnection: findConnectionMock,
  getLinearDeploymentMetadata: vi.fn(),
}));

import { linearSessionsRouter } from './linear-sessions';

function createCaller() {
  const auth: AuthTokenContext = {
    userId: 'user-1',
    tokenType: 'auth',
    version: 1,
  };

  return linearSessionsRouter.createCaller({ auth, req: undefined });
}

describe('linearSessionsRouter operator policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.R_CURATED_INTEGRATIONS_DISABLED = false;
  });

  it('blocks existing Linear sessions when curated integrations are disabled', async () => {
    envState.R_CURATED_INTEGRATIONS_DISABLED = true;

    await expect(createCaller().hasActiveConnection()).resolves.toBe(false);
    await expect(
      createCaller().emitThought({
        sessionId: 'session-1',
        content: 'Working',
      }),
    ).rejects.toThrow('Linear connection not found.');
    expect(findConnectionMock).not.toHaveBeenCalled();
    expect(getValidAccessTokenMock).not.toHaveBeenCalled();
  });
});
