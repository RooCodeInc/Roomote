import { buildConfiguredCommunicationProviders } from './provider-diagnostics';

const EMPTY_DIAGNOSTICS = {
  slackActiveCount: 0,
  teamsActiveCount: 0,
  telegramMappingCount: 0,
  discordActiveCount: 0,
  slackRuntimeConfigured: false,
  teamsRuntimeConfigured: false,
  telegramRuntimeConfigured: false,
  discordRuntimeConfigured: false,
};

describe('buildConfiguredCommunicationProviders', () => {
  it('reports Discord when an active guild installation exists', () => {
    expect(
      buildConfiguredCommunicationProviders({
        ...EMPTY_DIAGNOSTICS,
        discordActiveCount: 1,
      }),
    ).toEqual(['discord']);
  });

  it('reports Discord when the runtime token is configured', () => {
    expect(
      buildConfiguredCommunicationProviders({
        ...EMPTY_DIAGNOSTICS,
        discordRuntimeConfigured: true,
      }),
    ).toEqual(['discord']);
  });
});
