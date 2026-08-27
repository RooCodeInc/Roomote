const captureEvent = vi.hoisted(() => vi.fn());

vi.mock('@roomote/telemetry/server', () => ({ captureEvent }));

import { captureFastAgentInferenceContext } from '../fast-agent-context-telemetry';

describe('captureFastAgentInferenceContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records a privacy-safe component manifest for a complete warm turn', () => {
    captureFastAgentInferenceContext({
      userId: 'private-user-id',
      systemPrompt: 'private deployment prompt',
      surface: 'slack',
      turnSource: 'human',
      platformEventHandling: 'default',
      platformEventKind: 'delegated_task',
      sessionPath: 'warm',
      promptKind: 'turn_delta',
      attemptNumber: 1,
      attemptScope: 'prompt_submission',
      releasePresent: true,
      environmentCount: 2,
      taskModelCount: 3,
      activeTaskCount: 1,
      integrationCount: 2,
      integrationToolCount: 8,
      memoryIntegrationCount: 1,
      compatibilityMessageCount: 4,
      suppliedThreadMessageCount: 2,
      threadContextAttached: true,
      senderContextPresent: true,
      agentContextPresent: true,
      inputImageCount: 1,
      attachedImageCount: 1,
      degradedComponents: [],
    });

    expect(captureEvent).toHaveBeenCalledWith(
      'fast_agent_inference_context',
      expect.objectContaining({
        userId: 'private-user-id',
        properties: expect.objectContaining({
          manifest_version: 1,
          context_complete: true,
          session_path: 'warm',
          prompt_kind: 'turn_delta',
          attempt_number: 1,
          attempt_scope: 'prompt_submission',
          present_components: expect.arrayContaining([
            'current_turn',
            'native_history',
            'memory_capability',
            'style_guidance',
          ]),
          missing_components: [],
          input_image_count: 1,
          attached_image_count: 1,
        }),
      }),
    );
    const event = JSON.stringify(captureEvent.mock.calls[0]);
    expect(event).not.toContain('private deployment prompt');
  });

  it('marks loader failures and rebuilt retry context explicitly', () => {
    captureFastAgentInferenceContext({
      userId: 'user-1',
      systemPrompt: 'system',
      surface: 'automation',
      turnSource: 'platform_event',
      platformEventHandling: 'default',
      platformEventKind: 'automation',
      sessionPath: 'fallback_rebuild',
      promptKind: 'clean_retry_bootstrap',
      attemptNumber: 2,
      attemptScope: 'prompt_submission',
      releasePresent: false,
      environmentCount: 0,
      taskModelCount: 0,
      activeTaskCount: 0,
      integrationCount: 0,
      integrationToolCount: 0,
      memoryIntegrationCount: 0,
      compatibilityMessageCount: 2,
      suppliedThreadMessageCount: 0,
      threadContextAttached: false,
      senderContextPresent: false,
      agentContextPresent: false,
      inputImageCount: 0,
      attachedImageCount: 0,
      degradedComponents: ['integration_catalog', 'task_model_catalog'],
    });

    expect(captureEvent).toHaveBeenCalledWith(
      'fast_agent_inference_context',
      expect.objectContaining({
        properties: expect.objectContaining({
          context_complete: false,
          surface: 'automation',
          turn_source: 'platform_event',
          session_path: 'fallback_rebuild',
          prompt_kind: 'clean_retry_bootstrap',
          present_components: expect.arrayContaining([
            'bootstrap_history',
            'compatibility_history',
          ]),
          missing_components: ['integration_catalog', 'task_model_catalog'],
          missing_component_count: 2,
        }),
      }),
    );
    const properties = captureEvent.mock.calls[0]?.[1]?.properties;
    expect(properties.present_components).not.toContain('integration_catalog');
    expect(properties.present_components).not.toContain('task_model_catalog');
  });
});
