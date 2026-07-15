import {
  appendEnvironmentDefinitionGuidance,
  buildEnvironmentDefinitionWorkspacePayload,
  buildCreateEnvironmentDefinitionPrompt,
  RunStatus,
  getEnvironmentDefinitionIdFromPayload,
  type EnvironmentConfig,
} from '@roomote/types';

import {
  buildEnvironmentDefinitionFingerprint,
  buildSetupEnvironmentTaskTitle,
  buildUpdateEnvironmentDefinitionPrompt,
  findMatchingDefinedEnvironment,
  hasEnvironmentDefinitionChanged,
  isEnvironmentDefinitionSuccessStatus,
  isEnvironmentDefinitionTerminalSuccessStatus,
  wasEnvironmentUpdatedAfter,
} from './environment-definition';

const config: EnvironmentConfig = {
  name: 'Roomote App',
  repositories: [{ repository: 'acme/web' }, { repository: 'acme/api' }],
};

describe('environment definition helpers', () => {
  it('builds setup environment task titles from selected repository names', () => {
    expect(buildSetupEnvironmentTaskTitle(['acme/api'])).toBe(
      'Set up the api environment',
    );
    expect(buildSetupEnvironmentTaskTitle(['acme/api', 'acme/web'])).toBe(
      'Set up the api + web environment',
    );
    expect(buildSetupEnvironmentTaskTitle([])).toBe(
      'Set up your first environment',
    );
  });

  it('builds the create prompt with the environment-setup skill and sorted repositories', () => {
    const prompt = buildCreateEnvironmentDefinitionPrompt([
      'acme/web',
      'acme/api',
    ]);

    expect(prompt).toContain('$environment-setup');
    expect(prompt).toContain('- acme/api\n- acme/web');
    expect(prompt).toContain(
      'Do not mock or stub required services just to make the environment appear to work.',
    );
    expect(prompt).toContain(
      'Use a plain, stable environment name based on the product or repository name.',
    );
    expect(prompt).toContain(
      'Do not treat clearly pre-existing repository test failures as an automatic blocker',
    );
    expect(prompt).toContain(
      'Create the environment when validation is sufficient.',
    );
  });

  it('appends setup guidance only when the user provided it', () => {
    const basePrompt = buildCreateEnvironmentDefinitionPrompt(['acme/web']);

    expect(appendEnvironmentDefinitionGuidance(basePrompt, '   ')).toBe(
      basePrompt,
    );
    expect(
      appendEnvironmentDefinitionGuidance(
        basePrompt,
        'Start the API and worker services.',
      ),
    ).toContain('Additional setup guidance from the user:');
  });

  it('builds a scoped workspace payload for multi-repo setup tasks', () => {
    expect(
      buildEnvironmentDefinitionWorkspacePayload(['acme/web', 'acme/api']),
    ).toEqual({
      repo: '__all_repositories__',
      selectedRepositories: ['acme/api', 'acme/web'],
    });
  });

  it('builds the update prompt with the existing environment context', () => {
    const prompt = buildUpdateEnvironmentDefinitionPrompt({
      environmentId: 'env-123',
      environmentName: 'Roomote App',
      repositoryFullNames: ['acme/web', 'acme/api'],
      config,
    });

    expect(prompt).toContain(
      'Update the existing Roomote environment definition instead of creating a new one.',
    );
    expect(prompt).toContain('- ID: env-123');
    expect(prompt).toContain(
      'Keep the existing environment name unless the user explicitly asked to rename it.',
    );
    expect(prompt).toContain(
      'Do not treat clearly pre-existing repository test failures as an automatic blocker',
    );
    expect(prompt).toContain('action "update" and environmentId "env-123"');
    expect(prompt).toContain('name: Roomote App');
  });

  it('finds a created environment that matches the repository set after the task started', () => {
    const environment = findMatchingDefinedEnvironment(
      [
        {
          id: 'env-older',
          config,
          createdAt: '2026-03-19T12:00:00.000Z',
        },
        {
          id: 'env-123',
          config,
          createdAt: '2026-03-20T12:00:00.000Z',
        },
      ],
      ['acme/web', 'acme/api'],
      '2026-03-20T11:00:00.000Z',
    );

    expect(environment?.id).toBe('env-123');
  });

  it('finds an existing matching environment regardless of when it was created', () => {
    const environment = findMatchingDefinedEnvironment(
      [
        {
          id: 'env-older',
          config,
          createdAt: '2026-03-19T12:00:00.000Z',
        },
        {
          id: 'env-newer',
          config: {
            name: 'Other',
            repositories: [{ repository: 'acme/docs' }],
          },
          createdAt: '2026-03-20T12:00:00.000Z',
        },
      ],
      ['acme/web', 'acme/api'],
    );

    expect(environment?.id).toBe('env-older');
  });

  it('detects when an environment was updated after the task started', () => {
    expect(
      wasEnvironmentUpdatedAfter(
        { updatedAt: '2026-03-20T12:00:00.000Z' },
        '2026-03-20T11:00:00.000Z',
      ),
    ).toBe(true);
    expect(
      wasEnvironmentUpdatedAfter(
        { updatedAt: '2026-03-20T10:00:00.000Z' },
        '2026-03-20T11:00:00.000Z',
      ),
    ).toBe(false);
  });

  it('builds stable definition fingerprints for equivalent config objects', () => {
    const first = buildEnvironmentDefinitionFingerprint({
      name: 'Roomote App',
      description: null,
      config: {
        name: 'Roomote App',
        repositories: [{ repository: 'acme/web' }],
        tasks: {
          setup: { command: 'pnpm install' },
        },
      } as EnvironmentConfig,
    });

    const second = buildEnvironmentDefinitionFingerprint({
      name: 'Roomote App',
      description: null,
      config: {
        tasks: {
          setup: { command: 'pnpm install' },
        },
        repositories: [{ repository: 'acme/web' }],
        name: 'Roomote App',
      } as EnvironmentConfig,
    });

    expect(first).toBe(second);
  });

  it('detects when an environment definition changed from the baseline fingerprint', () => {
    const baselineFingerprint = buildEnvironmentDefinitionFingerprint({
      name: 'Roomote App',
      description: 'Original',
      config,
    });

    expect(
      hasEnvironmentDefinitionChanged(
        {
          name: 'Roomote App',
          description: 'Original',
          config,
        },
        baselineFingerprint,
      ),
    ).toBe(false);

    expect(
      hasEnvironmentDefinitionChanged(
        {
          name: 'Roomote App',
          description: 'Updated',
          config,
        },
        baselineFingerprint,
      ),
    ).toBe(true);
  });

  it.each([
    [RunStatus.Completed, null, true],
    [RunStatus.Idle, 'waiting_for_prompt', true],
    [RunStatus.Idle, 'running', false],
    [RunStatus.Running, null, false],
    [RunStatus.Failed, null, false],
  ] as const)(
    'treats %s with phase %s as a terminal success status: %s',
    (status, taskPhase, expected) => {
      expect(
        isEnvironmentDefinitionTerminalSuccessStatus(status, taskPhase),
      ).toBe(expected);
    },
  );

  it.each([
    [RunStatus.Completed, null, true],
    [RunStatus.Idle, 'waiting_for_prompt', true],
    [RunStatus.Idle, 'running', false],
    [RunStatus.Running, null, false],
    [RunStatus.Failed, null, false],
  ] as const)(
    'treats %s with phase %s as a success status: %s',
    (status, taskPhase, expected) => {
      expect(isEnvironmentDefinitionSuccessStatus(status, taskPhase)).toBe(
        expected,
      );
    },
  );

  it('reads the linked environment id from task run payload metadata', () => {
    expect(
      getEnvironmentDefinitionIdFromPayload({
        environmentDefinitionId: 'env-123',
      }),
    ).toBe('env-123');
    expect(
      getEnvironmentDefinitionIdFromPayload({
        environmentDefinitionId: '   ',
      }),
    ).toBeNull();
    expect(
      getEnvironmentDefinitionIdFromPayload({
        projectDefinitionEnvironmentId: 'env-legacy',
      }),
    ).toBe('env-legacy');
    expect(getEnvironmentDefinitionIdFromPayload(null)).toBeNull();
  });
});
