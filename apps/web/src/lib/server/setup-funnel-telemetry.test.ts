import { describe, expect, it } from 'vitest';

import {
  createEmptySetupNewState,
  type SetupAuthStatus,
  type SetupComputeStatus,
  type SetupModelStatus,
  type SetupSourceControlStatus,
} from '@roomote/types';

import {
  evaluateSetupFunnelMilestones,
  mergeSetupFunnelMilestones,
} from './setup-funnel-telemetry';

describe('setup funnel telemetry', () => {
  it('records each deployment milestone only once', () => {
    const result = mergeSetupFunnelMilestones(
      {
        authed: { at: '2026-08-01T00:00:00.000Z' },
      },
      [
        { milestone: 'authed' },
        {
          milestone: 'comms_configured',
          provider: 'slack',
          preexisting: false,
        },
        {
          milestone: 'comms_configured',
          provider: 'microsoft',
          preexisting: false,
        },
      ],
      '2026-08-02T00:00:00.000Z',
    );

    expect(result.inserted).toEqual([
      {
        milestone: 'comms_configured',
        provider: 'slack',
        preexisting: false,
      },
    ]);
    expect(result.milestones.comms_configured).toEqual({
      at: '2026-08-02T00:00:00.000Z',
      provider: 'slack',
      preexisting: false,
    });
  });

  it('derives achieved milestones from the setup status contracts', () => {
    const setupNewState = {
      ...createEmptySetupNewState(),
      authProvider: 'slack' as const,
      modelProvider: 'openai' as const,
      sourceControlProvider: 'github' as const,
      computeProvider: 'modal' as const,
    };
    const authSetup = {
      selectedProvider: 'slack',
      runtimeConfiguredProvider: null,
      providers: [{ id: 'slack', setupSatisfied: true }],
    } as unknown as SetupAuthStatus;
    const modelSetup = {
      setupSatisfied: true,
      persistedProviderId: 'openai',
      runtimeProviderId: null,
      preselectedProvider: 'openai',
    } as unknown as SetupModelStatus;
    const sourceControlSetup = {
      selectedProvider: 'github',
      runtimeConfiguredProvider: null,
      connectedProvider: 'github',
      setupSatisfied: true,
      providers: [
        { provider: 'github', configStepSatisfied: true, connected: true },
      ],
    } as unknown as SetupSourceControlStatus;
    const computeSetup = {
      selectedProvider: 'modal',
      runtimeDefaultProvider: null,
      persistedDefaultProvider: 'modal',
      providers: [{ provider: 'modal', configSatisfied: true }],
    } as unknown as SetupComputeStatus;

    expect(
      evaluateSetupFunnelMilestones({
        setupNewState,
        hasSlack: true,
        authSetup,
        modelSetup,
        sourceControlSetup,
        computeSetup,
      }),
    ).toEqual([
      { milestone: 'authed' },
      {
        milestone: 'comms_configured',
        provider: 'slack',
        preexisting: false,
      },
      {
        milestone: 'comms_authed',
        provider: 'slack',
        preexisting: false,
      },
      {
        milestone: 'inference_configured',
        provider: 'openai',
        preexisting: false,
      },
      {
        milestone: 'source_control_configured',
        provider: 'github',
        preexisting: false,
      },
      {
        milestone: 'source_control_authed',
        provider: 'github',
        preexisting: false,
      },
      {
        milestone: 'sandbox_configured',
        provider: 'modal',
        preexisting: false,
      },
    ]);
  });

  it('tags provider state discovered before a wizard choice as preexisting', () => {
    const setupNewState = createEmptySetupNewState();
    const authSetup = {
      selectedProvider: null,
      runtimeConfiguredProvider: null,
      preselectedProvider: 'microsoft',
      providers: [{ id: 'microsoft', setupSatisfied: true }],
    } as unknown as SetupAuthStatus;
    const modelSetup = {
      setupSatisfied: true,
      persistedProviderId: null,
      runtimeProviderId: 'anthropic',
      preselectedProvider: 'anthropic',
    } as unknown as SetupModelStatus;
    const sourceControlSetup = {
      selectedProvider: null,
      runtimeConfiguredProvider: null,
      connectedProvider: null,
      preselectedProvider: 'gitlab',
      setupSatisfied: false,
      providers: [{ provider: 'gitlab', configStepSatisfied: true }],
    } as unknown as SetupSourceControlStatus;
    const computeSetup = {
      selectedProvider: 'docker',
      runtimeDefaultProvider: 'docker',
      persistedDefaultProvider: null,
      providers: [{ provider: 'docker', configSatisfied: true }],
    } as unknown as SetupComputeStatus;

    const milestones = evaluateSetupFunnelMilestones({
      setupNewState,
      hasSlack: false,
      authSetup,
      modelSetup,
      sourceControlSetup,
      computeSetup,
    });

    expect(milestones.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          milestone: 'comms_configured',
          provider: 'microsoft',
          preexisting: true,
        }),
        expect.objectContaining({
          milestone: 'source_control_configured',
          provider: 'gitlab',
          preexisting: true,
        }),
        expect.objectContaining({
          milestone: 'inference_configured',
          preexisting: true,
        }),
        expect.objectContaining({
          milestone: 'sandbox_configured',
          preexisting: true,
        }),
      ]),
    );
  });
});
