import { ALL_REPOSITORIES } from '@roomote/types';

import { handleListEnvironments } from '../list-environments.js';
import * as tasksApiClient from '../tasks-api-client.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../tasks-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

describe('handleListEnvironments', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the canonical list_environments payload', async () => {
    vi.mocked(tasksApiClient.listEnvironments).mockResolvedValueOnce({
      environments: [
        {
          id: 'env-1',
          name: 'My Project',
          description: 'Main project env',
          repositories: [{ id: 1, fullName: 'owner/repo-a' }],
        },
      ],
    });

    const result = await handleListEnvironments(config);

    const payload = JSON.parse(result.content[0]?.text ?? '{}');
    expect(payload.instructions).toContain('Do not invent or guess');
    expect(payload.environments).toEqual([
      {
        environmentId: ALL_REPOSITORIES,
        name: 'All repositories',
        description:
          'Pass this environmentId to "launch" to run the task against all repositories',
      },
      {
        environmentId: 'env-1',
        name: 'My Project',
        description: 'Main project env',
      },
    ]);
  });

  it('returns the all-repositories target even when no named environments exist', async () => {
    vi.mocked(tasksApiClient.listEnvironments).mockResolvedValueOnce({
      environments: [],
    });

    const result = await handleListEnvironments(config);

    const payload = JSON.parse(result.content[0]?.text ?? '{}');
    expect(payload.environments).toEqual([
      {
        environmentId: ALL_REPOSITORIES,
        name: 'All repositories',
        description:
          'Pass this environmentId to "launch" to run the task against all repositories',
      },
    ]);
  });

  it('should return error on exception', async () => {
    vi.mocked(tasksApiClient.listEnvironments).mockRejectedValueOnce(
      new Error('Network error'),
    );

    const result = await handleListEnvironments(config);

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Network error');
  });
});
