import {
  resolveAggregateSourceControl,
  resolveStandardTaskSurface,
} from '../cloud-agent-workflow';

describe('resolveAggregateSourceControl', () => {
  it('preserves stamped provider and host for a homogeneous aggregate workspace', () => {
    expect(
      resolveAggregateSourceControl({
        sourceControlProvider: 'gitea',
        sourceControlHost: 'gitea.example.com',
      }),
    ).toEqual({
      provider: 'gitea',
      host: 'gitea.example.com',
    });
  });

  it('fails closed for a mixed aggregate workspace', () => {
    expect(
      resolveAggregateSourceControl({
        sourceControlProvider: 'gitlab',
        repositoryProviders: {
          'group/api': 'gitlab',
          'shared/app': 'gitea',
        },
      }),
    ).toBeUndefined();
  });

  it('fails closed when a selected aggregate mapping is incomplete', () => {
    expect(
      resolveAggregateSourceControl({
        sourceControlProvider: 'gitea',
        selectedRepositories: ['shared/api', 'shared/web'],
        repositoryProviders: {
          'shared/api': 'gitea',
        },
      }),
    ).toBeUndefined();
  });
});

describe('resolveStandardTaskSurface', () => {
  it('prefers Slack channel payload bindings', () => {
    expect(
      resolveStandardTaskSurface({
        hasSlackChannel: true,
        communicationProvider: 'discord',
        taskSurface: 'github',
      }),
    ).toBe('slack');
  });

  it('uses Teams/Telegram/Discord communication provider metadata', () => {
    expect(
      resolveStandardTaskSurface({
        hasSlackChannel: false,
        communicationProvider: 'teams',
        taskSurface: 'github',
      }),
    ).toBe('teams');
  });

  it('propagates GitHub launch surface for issue and PR mention tasks', () => {
    expect(
      resolveStandardTaskSurface({
        hasSlackChannel: false,
        communicationProvider: null,
        taskSurface: 'github',
      }),
    ).toBe('github');
  });

  it('keeps inherited communication context on the web surface', () => {
    expect(
      resolveStandardTaskSurface({
        hasSlackChannel: true,
        communicationProvider: 'slack',
        taskSurface: 'slack',
        communicationContextInherited: true,
      }),
    ).toBe('web');
  });

  it('falls back to web for api/system/missing launch surfaces', () => {
    expect(
      resolveStandardTaskSurface({
        hasSlackChannel: false,
        communicationProvider: null,
        taskSurface: 'api',
      }),
    ).toBe('web');
    expect(
      resolveStandardTaskSurface({
        hasSlackChannel: false,
        communicationProvider: null,
        taskSurface: null,
      }),
    ).toBe('web');
  });
});
