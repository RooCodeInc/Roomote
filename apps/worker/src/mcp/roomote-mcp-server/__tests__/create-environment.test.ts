import {
  buildEnvironmentProposal,
  handleCreateEnvironment,
  handlePreviewEnvironment,
  handleRecordVerification,
  handleUpdateEnvironment,
} from '../create-environment.js';
import * as tasksApiClient from '../tasks-api-client.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../tasks-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

const projectDefinition = {
  name: 'My Project',
  repositories: [{ repository: 'owner/repo' }],
};
const projectProposalHash =
  buildEnvironmentProposal(projectDefinition).proposalHash;

describe('handlePreviewEnvironment', () => {
  it('returns a concrete approval-bound proposal without mutating', async () => {
    const result = await handlePreviewEnvironment({
      definition: projectDefinition,
    });
    const parsed = JSON.parse(result.content[0]?.text ?? '');

    expect(parsed).toMatchObject({
      success: true,
      proposalHash: projectProposalHash,
      action: 'create',
      approvalRequired: true,
      summary: { name: 'My Project', repositories: 1, setupCommands: 0 },
    });
    expect(tasksApiClient.createEnvironment).not.toHaveBeenCalled();
  });

  it('changes the approval hash when the material proposal changes', () => {
    expect(buildEnvironmentProposal(projectDefinition).proposalHash).not.toBe(
      buildEnvironmentProposal({
        ...projectDefinition,
        services: ['postgres16'],
      }).proposalHash,
    );
  });
});

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
    });

    const result = await handleCreateEnvironment(
      {
        definition: `
name: My Project
repositories:
  - repository: owner/repo
`,
        format: 'yaml',
        approvedProposalHash: projectProposalHash,
      },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed.success).toBe(true);
    expect(parsed.environmentId).toBe('env-new');
    expect(parsed.name).toBe('My Project');
    expect(parsed.message).toBe(
      'Environment "My Project" created successfully.',
    );
  });

  it('applies a name override', async () => {
    vi.mocked(tasksApiClient.createEnvironment).mockResolvedValueOnce({
      success: true,
      environmentId: 'env-2',
      name: 'Renamed Project',
    });

    const result = await handleCreateEnvironment(
      {
        definition: {
          name: 'Original Name',
          repositories: [{ repository: 'owner/repo' }],
        },
        name: 'Renamed Project',
        approvedProposalHash: buildEnvironmentProposal({
          ...projectDefinition,
          name: 'Renamed Project',
        }).proposalHash,
      },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed.success).toBe(true);
    expect(parsed.name).toBe('Renamed Project');
    expect(parsed.message).toBe(
      'Environment "Renamed Project" created successfully.',
    );

    expect(tasksApiClient.createEnvironment).toHaveBeenCalledWith(config, {
      approvedProposalHash: expect.any(String),
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
          ...projectDefinition,
        },
        approvedProposalHash: projectProposalHash,
      },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('API unavailable');
  });

  it('rejects create when approval does not match the proposal', async () => {
    const result = await handleCreateEnvironment(
      { definition: projectDefinition, approvedProposalHash: 'stale' },
      config,
    );

    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({
      success: false,
      error: expect.stringContaining('Explicit approval is required'),
    });
    expect(tasksApiClient.createEnvironment).not.toHaveBeenCalled();
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
        approvedProposalHash: projectProposalHash,
      },
      config,
    );

    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text);

    expect(parsed.success).toBe(true);
    expect(parsed.environmentId).toBe('env-existing');
    expect(tasksApiClient.updateEnvironment).toHaveBeenCalledWith(config, {
      environmentId: 'env-existing',
      approvedProposalHash: projectProposalHash,
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

  it('rejects an update when the approved proposal is stale', async () => {
    const result = await handleUpdateEnvironment(
      {
        environmentId: 'env-existing',
        definition: { ...projectDefinition, services: ['postgres16'] },
        approvedProposalHash: projectProposalHash,
      },
      config,
    );

    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({
      success: false,
      error: expect.stringContaining('Explicit approval is required'),
    });
    expect(tasksApiClient.updateEnvironment).not.toHaveBeenCalled();
  });
});

describe('handleRecordVerification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('records a successful verification', async () => {
    vi.mocked(
      tasksApiClient.recordEnvironmentVerification,
    ).mockResolvedValueOnce({
      success: true,
      environmentId: 'env-1',
      isVerified: true,
    });

    const result = await handleRecordVerification(
      { environmentId: 'env-1', success: true },
      config,
    );

    const parsed = JSON.parse(result.content[0]?.text ?? '');

    expect(parsed.isVerified).toBe(true);
    expect(parsed.message).toBe(
      'Environment verification recorded as successful.',
    );
    expect(tasksApiClient.recordEnvironmentVerification).toHaveBeenCalledWith(
      config,
      {
        environmentId: 'env-1',
        success: true,
        error: undefined,
      },
    );
  });

  it('records a failed verification with an error message', async () => {
    vi.mocked(
      tasksApiClient.recordEnvironmentVerification,
    ).mockResolvedValueOnce({
      success: true,
      environmentId: 'env-1',
      isVerified: false,
    });

    const result = await handleRecordVerification(
      { environmentId: 'env-1', success: false, error: 'boot failed' },
      config,
    );

    const parsed = JSON.parse(result.content[0]?.text ?? '');

    expect(parsed.isVerified).toBe(false);
    expect(parsed.message).toBe('Environment verification recorded as failed.');
    expect(tasksApiClient.recordEnvironmentVerification).toHaveBeenCalledWith(
      config,
      {
        environmentId: 'env-1',
        success: false,
        error: 'boot failed',
      },
    );
  });

  it('requires an environment id', async () => {
    const result = await handleRecordVerification(
      { environmentId: '   ', success: true },
      config,
    );

    const parsed = JSON.parse(result.content[0]?.text ?? '');

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe(
      'environmentId is required for record_verification',
    );
    expect(tasksApiClient.recordEnvironmentVerification).not.toHaveBeenCalled();
  });
});
