import type { CommunicationProvider } from './communication';
import type { ComputeProvider } from './compute-providers';
import type { SetupModelProviderId } from './model-provider-config';
import {
  isSetupAuthProviderId,
  type SetupAuthProviderId,
} from './setup-auth-config';
import type { SourceControlProvider } from './source-control';

/**
 * Pre-runtime task phase used while first-time hosted compute provisioning is
 * still creating the selected provider's deployment-wide worker artifact.
 * Runs in this phase are persisted but deliberately not placed on the
 * controller queue until provisioning succeeds.
 */
export const WAITING_FOR_SANDBOX_PROVIDER_TASK_PHASE =
  'waiting_for_sandbox_provider' as const;

/**
 * Progress of a setup-time worker base-image provisioning run (an E2B
 * template build, Daytona snapshot registration, Blaxel image build, or Azure
 * disk image bake). The run
 * executes detached in the web process after the provider's config is
 * saved, so a `building` entry older than
 * {@link SETUP_COMPUTE_PROVISIONING_STALE_MS} is treated as failed (the
 * process likely restarted mid-run) and the UI offers a retry.
 */
export type SetupNewComputeProvisioningState = {
  status: 'building' | 'succeeded' | 'failed';
  /** Worker runtime contract used to build this provider artifact. */
  runtimeSchemaVersion: number;
  imageRef: string;
  /** Provider-side artifact reference (template, snapshot, or image ref). */
  templateRef: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export const SETUP_COMPUTE_PROVISIONING_STALE_MS = 20 * 60_000;

export function isSetupNewComputeProvisioningStale(
  state: SetupNewComputeProvisioningState | null | undefined,
  now: number = Date.now(),
): boolean {
  return (
    state?.status === 'building' &&
    now - Date.parse(state.startedAt) > SETUP_COMPUTE_PROVISIONING_STALE_MS
  );
}

/**
 * Read-time view of the persisted provisioning state: a stale `building`
 * entry is presented as failed so the UI offers a retry instead of spinning
 * forever after a web-process restart killed the detached run.
 */
export function presentSetupNewComputeProvisioning(
  state: SetupNewComputeProvisioningState | null | undefined,
  now: number = Date.now(),
): SetupNewComputeProvisioningState | null {
  if (!state) {
    return null;
  }

  if (isSetupNewComputeProvisioningStale(state, now)) {
    return {
      ...state,
      status: 'failed',
      error:
        'Provisioning did not finish in time. It may have been interrupted by a restart — retry to start a new run.',
    };
  }

  return state;
}

/**
 * Providers whose worker base image can be provisioned during setup, mapped
 * to the SetupNewState field that tracks the run. The persisted field names
 * are historical (`e2bTemplateBuild` predates the generalization) and must
 * not change without migrating in-flight state.
 */
export const SETUP_COMPUTE_PROVISIONING_STATE_FIELDS = {
  e2b: 'e2bTemplateBuild',
  daytona: 'daytonaSnapshotBuild',
  blaxel: 'blaxelImageBuild',
  azure: 'azureDiskImageBuild',
} as const satisfies Partial<Record<ComputeProvider, keyof SetupNewState>>;

export type AutomationRecommendation = {
  id: string;
  candidateId: string;
  /** Client-safe display metadata. Older persisted batches are hydrated server-side. */
  title?: string;
  rank: number;
  score: number;
  explanation: string;
  enabled: boolean;
  lastRunTaskId: string | null;
  automationId: string | null;
  /** Whether setup or an explicit Home action created the automation. */
  applied?: boolean;
  /** Set while a durable initial-run job owns this recommendation. */
  initialRunClaimedAt?: string | null;
  /** Set immediately before the initial-run job starts dispatching work. */
  initialRunDispatchAttemptedAt?: string | null;
  /** Terminal marker preventing a paid initial run from being repeated. */
  initialRunTerminalAt?: string | null;
};

export type AutomationRecommendationApplicationState =
  | 'pending'
  | 'applied'
  | 'skipped';

export type AutomationRecommendationBatch = {
  version: 1;
  inputFingerprint: string;
  catalogVersion: number;
  status: 'pending' | 'ready' | 'failed';
  startedAt: string;
  completedAt: string | null;
  partial: boolean;
  errorCode: string | null;
  recommendations: AutomationRecommendation[];
  dismissed: boolean;
  /** Whether setup has applied the selected recommendation settings. */
  applicationState?: AutomationRecommendationApplicationState;
};

export type SetupProvisionableComputeProvider =
  keyof typeof SETUP_COMPUTE_PROVISIONING_STATE_FIELDS;

export const isSetupProvisionableComputeProvider = (
  provider: ComputeProvider,
): provider is SetupProvisionableComputeProvider =>
  provider in SETUP_COMPUTE_PROVISIONING_STATE_FIELDS;

export function getSetupNewComputeProvisioningState(
  state: SetupNewState,
  provider: SetupProvisionableComputeProvider,
): SetupNewComputeProvisioningState | null {
  return state[SETUP_COMPUTE_PROVISIONING_STATE_FIELDS[provider]];
}

export type SetupNewState = {
  version: 1;
  authProvider: SetupAuthProviderId | null;
  modelProvider: SetupModelProviderId | null;
  computeProvider: ComputeProvider | null;
  sourceControlProvider: SourceControlProvider | null;
  selectedRepositoryIds: string[];
  setupGuidance: string | null;
  selectedModelId: string | null;
  onboardingTaskId: string | null;
  onboardingTaskStartedAt: string | null;
  slackTeamId: string | null;
  slackChannel: string | null;
  slackThreadTs: string | null;
  /**
   * Provider-neutral record of the chat surface that received the setup
   * kickoff (Slack DM, Telegram primary chat, or Teams primary
   * conversation). The legacy Slack fields above stay populated for Slack
   * handoffs; these fields are the source of truth for non-Slack surfaces.
   */
  chatHandoffProvider: CommunicationProvider | null;
  chatHandoffChannelId: string | null;
  chatHandoffThreadId: string | null;
  chatHandoffServiceUrl: string | null;
  suggestionTaskId: string | null;
  suggestionTaskStartedAt: string | null;
  suggestionGenerationTriggeredAt: string | null;
  e2bTemplateBuild: SetupNewComputeProvisioningState | null;
  daytonaSnapshotBuild: SetupNewComputeProvisioningState | null;
  blaxelImageBuild: SetupNewComputeProvisioningState | null;
  azureDiskImageBuild: SetupNewComputeProvisioningState | null;
  lastInteractedByUserId: string | null;
  automationRecommendations: AutomationRecommendationBatch | null;
};

export function createEmptySetupNewState(): SetupNewState {
  return {
    version: 1,
    authProvider: null,
    modelProvider: null,
    computeProvider: null,
    sourceControlProvider: null,
    selectedRepositoryIds: [],
    setupGuidance: null,
    selectedModelId: null,
    onboardingTaskId: null,
    onboardingTaskStartedAt: null,
    slackTeamId: null,
    slackChannel: null,
    slackThreadTs: null,
    chatHandoffProvider: null,
    chatHandoffChannelId: null,
    chatHandoffThreadId: null,
    chatHandoffServiceUrl: null,
    suggestionTaskId: null,
    suggestionTaskStartedAt: null,
    suggestionGenerationTriggeredAt: null,
    e2bTemplateBuild: null,
    daytonaSnapshotBuild: null,
    blaxelImageBuild: null,
    azureDiskImageBuild: null,
    lastInteractedByUserId: null,
    automationRecommendations: null,
  };
}

/**
 * True when the setup kickoff reached a chat surface (legacy Slack fields or
 * the provider-neutral handoff fields), meaning onboarding progress flows
 * through that conversation rather than only the `/setup` task panel.
 */
export function hasSetupChatHandoffDestination(
  state: Pick<SetupNewState, 'slackChannel' | 'chatHandoffChannelId'>,
): boolean {
  return Boolean(state.slackChannel || state.chatHandoffChannelId);
}

export function normalizeSetupNewState(
  state: Partial<SetupNewState> | null | undefined,
): SetupNewState {
  const emptyState = createEmptySetupNewState();

  const normalizedState = Object.fromEntries(
    (Object.keys(emptyState) as Array<keyof SetupNewState>).map((key) => [
      key,
      state?.[key] ?? emptyState[key],
    ]),
  ) as SetupNewState;

  return {
    ...normalizedState,
    authProvider: isSetupAuthProviderId(normalizedState.authProvider)
      ? normalizedState.authProvider
      : null,
  };
}
