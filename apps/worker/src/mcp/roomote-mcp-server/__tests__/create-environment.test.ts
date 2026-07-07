import {
  handleCreateEnvironment,
  handleUpdateEnvironment,
} from '../create-environment.js';
import * as tasksApiClient from '../tasks-api-client.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../tasks-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

describe('handleCreateEnvironment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('parses YAML definition and returns success payload', async () => {
    vi.mocked(tasksApiClient.createEnvironment).mockResolvedValueOnce({
      success: true,
      environmentId: 'env-new',
      name: 'My Project',
      missingRepositories: [],
    });

    const result = await handleCreateEnvironment(
      {
        definition: `
name: My Project
repositories:
  - repository: owner/repo
`,
        format: 'yaml',
      },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed.success).toBe(true);
    expect(parsed.environmentId).toBe('env-new');
    expect(parsed.name).toBe('My Project');
    expect(parsed.missingRepositories).toEqual([]);
  });

  it('applies name override and surfaces missing repository warnings', async () => {
    vi.mocked(tasksApiClient.createEnvironment).mockResolvedValueOnce({
      success: true,
      environmentId: 'env-2',
      name: 'Renamed Project',
      missingRepositories: ['owner/missing-repo'],
    });

    const result = await handleCreateEnvironment(
      {
        definition: {
          name: 'Original Name',
          repositories: [{ repository: 'owner/repo' }],
        },
        name: 'Renamed Project',
      },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed.success).toBe(true);
    expect(parsed.name).toBe('Renamed Project');
    expect(parsed.missingRepositories).toEqual(['owner/missing-repo']);

    expect(tasksApiClient.createEnvironment).toHaveBeenCalledWith(config, {
      config: expect.objectContaining({ name: 'Renamed Project' }),
    });
  });

  it('returns validation error for invalid definitions', async () => {
    const result = await handleCreateEnvironment(
      {
        definition: {
          repositories: [{ repository: 'owner/repo' }],
        },
      },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Invalid environment configuration');
    expect(tasksApiClient.createEnvironment).not.toHaveBeenCalled();
  });

  it('returns error on downstream API failure', async () => {
    vi.mocked(tasksApiClient.createEnvironment).mockRejectedValueOnce(
      new Error('API unavailable'),
    );

    const result = await handleCreateEnvironment(
      {
        definition: {
          name: 'My Project',
          repositories: [{ repository: 'owner/repo' }],
        },
      },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('API unavailable');
  });
});

describe('handleUpdateEnvironment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('updates an existing environment from YAML input', async () => {
    vi.mocked(tasksApiClient.updateEnvironment).mockResolvedValueOnce({
      success: true,
      environmentId: 'env-existing',
      name: 'My Project',
      missingRepositories: [],
    });

    const result = await handleUpdateEnvironment(
      {
        environmentId: 'env-existing',
        definition: `
name: My Project
repositories:
  - repository: owner/repo
`,
        format: 'yaml',
      },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed.success).toBe(true);
    expect(parsed.environmentId).toBe('env-existing');
    expect(tasksApiClient.updateEnvironment).toHaveBeenCalledWith(config, {
      environmentId: 'env-existing',
      config: expect.objectContaining({ name: 'My Project' }),
    });
  });

  it('requires an environment id for updates', async () => {
    const result = await handleUpdateEnvironment(
      {
        environmentId: '   ',
        definition: {
          name: 'My Project',
          repositories: [{ repository: 'owner/repo' }],
        },
      },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('environmentId is required for update');
    expect(tasksApiClient.updateEnvironment).not.toHaveBeenCalled();
  });
});
