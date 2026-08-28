const captureEvent = vi.hoisted(() => vi.fn());

vi.mock('@roomote/telemetry/server', () => ({ captureEvent }));

import {
  captureFastAgentInferenceAttemptOutcome,
  captureFastAgentInferenceContext,
  captureFastAgentTurnSettled,
} from '../fast-agent-context-telemetry';

describe('captureFastAgentInferenceContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records a privacy-safe component manifest for a complete warm turn', () => {
    captureFastAgentInferenceContext({
      userId: 'private-user-id',
      sessionId: 'private-session-id',
      turnId: 'private-turn-id',
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
          session_id_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
          turn_id_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
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
    expect(event).not.toContain('private-session-id');
    expect(event).not.toContain('private-turn-id');
  });

  it('marks loader failures and rebuilt retry context explicitly', () => {
    captureFastAgentInferenceContext({
      userId: 'user-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
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

  it('records attempt outcomes without prompt or raw error content', () => {
    captureFastAgentInferenceAttemptOutcome({
      userId: 'user-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      surface: 'web',
      sessionPath: 'cold_rebuild',
      promptKind: 'bootstrap',
      attemptNumber: 1,
      outcome: 'failure',
      stage: 'opencode_setup',
      elapsedMs: 654,
      failureReason: 'endpoint_unreachable',
      failureRetryable: true,
      resolvedModel: 'openrouter/openai/gpt-test',
      providerRetryEventCount: 0,
    });

    expect(captureEvent).toHaveBeenCalledWith(
      'fast_agent_inference_attempt_outcome',
      expect.objectContaining({
        properties: expect.objectContaining({
          outcome: 'failure',
          stage: 'opencode_setup',
          elapsed_ms: 654,
          failure_reason: 'endpoint_unreachable',
          failure_retryable: true,
          resolved_model: 'openrouter/openai/gpt-test',
          provider: 'openrouter',
          provider_retry_event_count: 0,
        }),
      }),
    );
    expect(JSON.stringify(captureEvent.mock.calls[0])).not.toContain(
      'session-1',
    );
    expect(JSON.stringify(captureEvent.mock.calls[0])).not.toContain('turn-1');
  });

  it('records identifier-free first-response and startup timings', () => {
    captureFastAgentTurnSettled({
      userId: 'private-user-id',
      surface: 'web',
      turnSource: 'human',
      sessionPath: 'cold_rebuild',
      outcome: 'success',
      serviceDurationMs: 1_250,
      firstResponseDurationMs: 900,
      sandboxlessStartupDurationMs: 350,
      inferenceToFirstResponseDurationMs: 550,
      inferenceDurationMs: 700,
      postInferenceDurationMs: 200,
      visibleReplyCount: 1,
      openCodeProviderRetryEventCount: 0,
      roomoteInferenceRetryCount: 0,
    });

    expect(captureEvent).toHaveBeenCalledWith('fast_turn_settled', {
      userId: 'private-user-id',
      properties: {
        surface: 'web',
        turn_source: 'human',
        session_path: 'cold_rebuild',
        outcome: 'success',
        service_duration_ms: 1_250,
        first_response_duration_ms: 900,
        sandboxless_startup_duration_ms: 350,
        inference_to_first_response_duration_ms: 550,
        inference_duration_ms: 700,
        post_inference_duration_ms: 200,
        had_assistant_response: true,
        visible_reply_count: 1,
        opencode_provider_retry_event_count: 0,
        roomote_inference_retry_count: 0,
      },
    });
    expect(captureEvent.mock.calls[0]?.[1]?.properties).not.toHaveProperty(
      'session_id',
    );
    expect(captureEvent.mock.calls[0]?.[1]?.properties).not.toHaveProperty(
      'turn_id',
    );
  });
});
