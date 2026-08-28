import { createHash } from 'node:crypto';

import { captureEvent } from '@roomote/telemetry/server';

import type {
  FastAgentPlatformEventHandling,
  FastAgentPlatformEventKind,
  FastAgentSurface,
  FastAgentTurnSource,
} from './fast-agent-conversation';

const FAST_AGENT_CONTEXT_MANIFEST_VERSION = 1;

export type FastAgentSessionPath =
  | 'warm'
  | 'cold_resume'
  | 'cold_rebuild'
  | 'fallback_rebuild';

export type FastAgentPromptKind =
  | 'turn_delta'
  | 'bootstrap'
  | 'clean_retry_bootstrap'
  | 'side_effect_retry_recovery';

const REQUIRED_SYSTEM_COMPONENTS = [
  'active_tasks',
  'capability_boundary',
  'conversation_policy',
  'environment_catalog',
  'integration_catalog',
  'native_tool_policy',
  'style_guidance',
  'surface_policy',
  'task_model_catalog',
] as const;

export type CaptureFastAgentInferenceContextInput = {
  userId: string;
  sessionId: string;
  turnId: string;
  systemPrompt: string;
  surface: FastAgentSurface;
  turnSource: FastAgentTurnSource;
  platformEventHandling: FastAgentPlatformEventHandling;
  platformEventKind: FastAgentPlatformEventKind;
  sessionPath: FastAgentSessionPath;
  promptKind: FastAgentPromptKind;
  attemptNumber: number;
  attemptScope: 'prompt_submission' | 'provider_retry';
  providerRetryAttempt?: number;
  releasePresent: boolean;
  environmentCount: number;
  taskModelCount: number;
  activeTaskCount: number;
  integrationCount: number;
  integrationToolCount: number;
  memoryIntegrationCount: number;
  compatibilityMessageCount: number;
  suppliedThreadMessageCount: number;
  threadContextAttached: boolean;
  senderContextPresent: boolean;
  agentContextPresent: boolean;
  inputImageCount: number;
  attachedImageCount: number;
  degradedComponents: string[];
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Records component presence only. Prompt text, identifiers, names, and other
 * user or deployment content must never be added to this event.
 */
export function captureFastAgentInferenceContext(
  input: CaptureFastAgentInferenceContextInput,
): void {
  const missingComponents = [...new Set(input.degradedComponents)].sort();
  const missingComponentSet = new Set(missingComponents);
  const presentComponents = [
    ...REQUIRED_SYSTEM_COMPONENTS,
    'current_turn',
    input.promptKind === 'bootstrap' ||
    input.promptKind === 'clean_retry_bootstrap'
      ? 'bootstrap_history'
      : 'native_history',
    ...(input.releasePresent ? ['release'] : []),
    ...(input.compatibilityMessageCount > 0 &&
    (input.promptKind === 'bootstrap' ||
      input.promptKind === 'clean_retry_bootstrap')
      ? ['compatibility_history']
      : []),
    ...(input.threadContextAttached ? ['thread_context'] : []),
    ...(input.senderContextPresent ? ['sender_context'] : []),
    ...(input.agentContextPresent ? ['agent_context'] : []),
    ...(input.inputImageCount > 0 ? ['image_context'] : []),
    ...(input.memoryIntegrationCount > 0 ? ['memory_capability'] : []),
  ]
    .filter((component) => !missingComponentSet.has(component))
    .sort();
  const manifestHash = sha256(
    JSON.stringify({
      version: FAST_AGENT_CONTEXT_MANIFEST_VERSION,
      presentComponents,
      missingComponents,
      promptKind: input.promptKind,
      attachedImageCount: input.attachedImageCount,
    }),
  );

  void captureEvent('fast_agent_inference_context', {
    userId: input.userId,
    properties: {
      manifest_version: FAST_AGENT_CONTEXT_MANIFEST_VERSION,
      manifest_hash: manifestHash,
      system_prompt_hash: sha256(input.systemPrompt),
      system_prompt_length: input.systemPrompt.length,
      context_complete: missingComponents.length === 0,
      present_components: presentComponents,
      present_component_count: presentComponents.length,
      missing_components: missingComponents,
      missing_component_count: missingComponents.length,
      surface: input.surface,
      turn_source: input.turnSource,
      platform_event_handling: input.platformEventHandling,
      platform_event_kind: input.platformEventKind,
      session_path: input.sessionPath,
      prompt_kind: input.promptKind,
      attempt_number: input.attemptNumber,
      attempt_scope: input.attemptScope,
      provider_retry_attempt: input.providerRetryAttempt ?? null,
      session_id_hash: sha256(input.sessionId),
      turn_id_hash: sha256(input.turnId),
      release_present: input.releasePresent,
      environment_count: input.environmentCount,
      task_model_count: input.taskModelCount,
      active_task_count: input.activeTaskCount,
      integration_count: input.integrationCount,
      integration_tool_count: input.integrationToolCount,
      memory_integration_count: input.memoryIntegrationCount,
      compatibility_message_count: input.compatibilityMessageCount,
      supplied_thread_message_count: input.suppliedThreadMessageCount,
      thread_context_attached: input.threadContextAttached,
      sender_context_present: input.senderContextPresent,
      agent_context_present: input.agentContextPresent,
      input_image_count: input.inputImageCount,
      attached_image_count: input.attachedImageCount,
    },
  });
}

type CaptureFastAgentInferenceAttemptOutcomeInput = {
  userId: string;
  sessionId: string;
  turnId: string;
  surface: FastAgentSurface;
  sessionPath: FastAgentSessionPath;
  promptKind: FastAgentPromptKind;
  attemptNumber: number;
  outcome: 'success' | 'failure';
  stage: 'model_resolution' | 'opencode_setup' | 'model_generation';
  elapsedMs: number;
  failureReason?: string;
  failureRetryable?: boolean;
  resolvedModel?: string;
  providerRetryEventCount: number;
};

export function captureFastAgentInferenceAttemptOutcome(
  input: CaptureFastAgentInferenceAttemptOutcomeInput,
): void {
  void captureEvent('fast_agent_inference_attempt_outcome', {
    userId: input.userId,
    properties: {
      session_id_hash: sha256(input.sessionId),
      turn_id_hash: sha256(input.turnId),
      surface: input.surface,
      session_path: input.sessionPath,
      prompt_kind: input.promptKind,
      attempt_number: input.attemptNumber,
      outcome: input.outcome,
      stage: input.stage,
      elapsed_ms: input.elapsedMs,
      failure_reason: input.failureReason ?? null,
      failure_retryable: input.failureRetryable ?? null,
      resolved_model: input.resolvedModel ?? null,
      provider: input.resolvedModel?.split('/')[0] ?? null,
      provider_retry_event_count: input.providerRetryEventCount,
    },
  });
}
