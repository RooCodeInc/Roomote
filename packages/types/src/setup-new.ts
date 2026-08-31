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

export const SETUP_STARTER_TASK_IDS = [
  'speed-up-ci',
  'security-scan',
  'fix-test-flakes',
  'update-dependencies',
] as const;

export type SetupStarterTaskId = (typeof SETUP_STARTER_TASK_IDS)[number];

export function isSetupStarterTaskId(
  value: unknown,
): value is SetupStarterTaskId {
  return (
    typeof value === 'string' &&
    (SETUP_STARTER_TASK_IDS as readonly string[]).includes(value)
  );
}

/**
 * Linkage between deployment setup and the persisted conversational setup
 * Fast session. This deliberately stays a small additive JSON shape so
 * existing deployments need no migration and checklist state stays derived.
 */
export type SetupNewSetupSession = {
  /** Unified (canonical) session ID shown in routes and transcript. */
  sessionId: string;
  startedAt: string;
  starterTaskSelection: {
    requestId: string;
    taskIds: SetupStarterTaskId[];
    selectedAt: string;
  } | null;
};

export function createSetupNewSetupSession(input: {
  sessionId: string;
  startedAt?: string;
}): SetupNewSetupSession {
  return {
    sessionId: input.sessionId,
    startedAt: input.startedAt ?? new Date().toISOString(),
    starterTaskSelection: null,
  };
}

/**
 * Parse and normalize a persisted setup-session linkage. Returns null for
 * absent or malformed values so older JSON without setup metadata, partially
 * written rows, or corrupt payloads degrade to a fresh session instead of
 * breaking setup.
 */
export function normalizeSetupNewSetupSession(
  value: unknown,
): SetupNewSetupSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sessionId = asNonEmptyString(record.sessionId);
  const startedAt = asIsoTimestamp(record.startedAt);
  if (!sessionId || !startedAt) {
    return null;
  }

  let starterTaskSelection: SetupNewSetupSession['starterTaskSelection'] = null;
  if (
    record.starterTaskSelection &&
    typeof record.starterTaskSelection === 'object' &&
    !Array.isArray(record.starterTaskSelection)
  ) {
    const selection = record.starterTaskSelection as Record<string, unknown>;
    const requestId = asNonEmptyString(selection.requestId);
    const selectedAt = asIsoTimestamp(selection.selectedAt);
    const taskIds = Array.isArray(selection.taskIds)
      ? [...new Set(selection.taskIds.filter(isSetupStarterTaskId))]
      : [];
    if (requestId && selectedAt && taskIds.length > 0) {
      starterTaskSelection = { requestId, taskIds, selectedAt };
    }
  }

  return {
    sessionId,
    startedAt,
    starterTaskSelection,
  };
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asIsoTimestamp(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

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
  /**
   * Conversational setup session linkage. Optional for backward
   * compatibility with deployments whose persisted state predates the
   * conversational setup flow; normalization supplies null.
   */
  setupSession: SetupNewSetupSession | null;
  /**
   * When the hosting-injected Roomote inference key was imported from the
   * process environment into encrypted Settings storage. One-shot: once
   * stamped, the env value is never imported again, so deleting the Roomote
   * inference provider (its stored key) disables the trial permanently even
   * though the hosting platform keeps delivering the variable.
   */
  trialInferenceKeyImportedAt: string | null;
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
    setupSession: null,
    trialInferenceKeyImportedAt: null,
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
    setupSession: normalizeSetupNewSetupSession(state?.setupSession),
  };
}
