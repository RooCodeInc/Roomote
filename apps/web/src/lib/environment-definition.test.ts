import {
  appendEnvironmentDefinitionGuidance,
  buildEnvironmentDefinitionWorkspacePayload,
  buildCreateEnvironmentDefinitionPrompt,
  RunStatus,
  getEnvironmentDefinitionIdFromPayload,
  normalizeRepositorySelection,
  type EnvironmentConfig,
} from '@roomote/types';

import {
  buildEnvironmentDefinitionFingerprint,
  buildEnvironmentPreviewRepairPrompt,
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

  it('builds the create prompt with repositories in selection order', () => {
    const prompt = buildCreateEnvironmentDefinitionPrompt([
      'acme/web',
      'acme/api',
    ]);

    expect(prompt).toContain('$environment-setup');
    expect(prompt).toContain('- acme/web\n- acme/api');
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

  it('flags empty repositories in the create prompt with bootstrap instructions', () => {
    const prompt = buildCreateEnvironmentDefinitionPrompt(
      ['acme/web', 'acme/new-repo'],
      { emptyRepositoryFullNames: ['acme/new-repo'] },
    );

    expect(prompt).toContain(
      'These repositories are brand new and have no commits yet:\n- acme/new-repo',
    );
    expect(prompt).toContain(
      "follow the skill's empty-repository bootstrap: push exactly one initial commit containing only a README.md and a minimal .gitignore",
    );
    expect(prompt).toContain('Do not scaffold application code');
  });

  it('ignores empty-repository flags outside the selected repository set', () => {
    const basePrompt = buildCreateEnvironmentDefinitionPrompt(['acme/web']);

    expect(
      buildCreateEnvironmentDefinitionPrompt(['acme/web'], {
        emptyRepositoryFullNames: ['acme/other'],
      }),
    ).toBe(basePrompt);
    expect(
      buildCreateEnvironmentDefinitionPrompt(['acme/web'], {
        emptyRepositoryFullNames: [],
      }),
    ).toBe(basePrompt);
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
      selectedRepositories: ['acme/web', 'acme/api'],
    });
  });

  it('rejects duplicate repository names before building a workspace', () => {
    expect(() =>
      buildEnvironmentDefinitionWorkspacePayload([
        'group/project',
        'group/project',
      ]),
    ).toThrow(
      'The selected repositories include multiple entries named "group/project".',
    );
  });

  it('deduplicates repository selections without changing their order', () => {
    expect(
      normalizeRepositorySelection([
        { id: 'repo-web', fullName: 'acme/web' },
        { id: 'repo-api', fullName: 'acme/api' },
        { id: 'repo-web', fullName: 'acme/web' },
      ]),
    ).toEqual(['repo-web', 'repo-api']);
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
      'Repositories to inspect:\n- acme/web\n- acme/api',
    );
    expect(prompt).toContain(
      'Keep the existing environment name unless the user explicitly asked to rename it.',
    );
    expect(prompt).toContain(
      'Do not treat clearly pre-existing repository test failures as an automatic blocker',
    );
    expect(prompt).toContain('action "update" and environmentId "env-123"');
    expect(prompt).toContain('name: Roomote App');
  });

  it('directs preview repair tasks through the public preview URL', () => {
    const prompt = buildEnvironmentPreviewRepairPrompt({
      environmentId: 'env-123',
      environmentName: 'Roomote App',
      config,
    });

    expect(prompt).toContain('ROOMOTE_<PORT_NAME>_PREVIEW_URL');
    expect(prompt).toContain(
      'falling back to `ROOMOTE_<PORT_NAME>_HOST` only when the preview URL variable is unavailable',
    );
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
