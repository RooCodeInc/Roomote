import { resolveStandardTaskSurface } from '../cloud-agent-workflow';

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
