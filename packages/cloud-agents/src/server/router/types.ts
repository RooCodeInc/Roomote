import type {
  RequestedWorkKindDecision,
  TaskModelOption,
  TaskModelSettings,
} from '@roomote/types';

/** Time to wait before auto-accepting a routed workspace suggestion. */
export const ROUTING_AUTO_CONFIRM_TIMEOUT_MS = 30_000;

/** Confidence required to skip the correction window entirely. */
export const ROUTING_IMMEDIATE_AUTO_CONFIRM_CONFIDENCE = 0.95;

/**
 * Time in milliseconds to wait for the user to confirm or correct
 * the routing suggestion before auto-accepting it (Linear).
 * Longer than Slack since users interact less frequently.
 */
export const LINEAR_AUTO_CONFIRM_TIMEOUT_MS = 120_000;

export const R_SMALL_MODEL_LABEL = 'roomote-small-model';

/**
 * Model for workspace-routing inference: an explicit context.routingModel
 * wins, then the R_ROUTER_MODEL deployment override. No model id is ever
 * hardcoded here — the correct id depends on the deployment's provider
 * configuration (e.g. openrouter/google/... vs google/...), so returning
 * undefined defers to the deployment small-model resolution.
 */
export function resolveRoutingModel(
  explicitModel?: string,
): string | undefined {
  return (
    explicitModel?.trim() || process.env.R_ROUTER_MODEL?.trim() || undefined
  );
}

/**
 * Maximum length for task descriptions to prevent excessive token usage.
 */
export const MAX_TASK_DESCRIPTION_LENGTH = 2000;

/**
 * Maximum number of thread messages to include in context.
 */
export const MAX_THREAD_MESSAGES = 5;

export const PLATFORM_WORKSPACE_VALUE = '__platform__';

/**
 * Context provided to the router for making routing decisions.
 */
export interface RoutingContext {
  taskDescription: string;
  routingModel?: string;
  source: RoutingSource;
  availableEnvironments: RoutableEnvironment[];
  /**
   * Deployment task-model settings. When present, the enabled model catalog is
   * exposed to the routing prompt so the LLM can pick a requested model, and
   * the router resolves the final model from that pick (or the deployment
   * default) instead of parsing the task text in code.
   * `null` means the deployment settings row is missing and the built-in
   * default catalog should be used; `undefined` means model selection is not
   * available for this routing context.
   */
  taskModelSettings?: TaskModelSettings | null;
  routingActor?: {
    userId: string;
    apiBaseUrl?: string;
  };
  previousSuggestion?: {
    workspaceValue: string | null;
    workspaceDisplayName: string;
    modelId?: string | null;
    modelDisplayName?: string | null;
  };
}

export interface RoutingTaskModelSelection extends Pick<
  TaskModelOption,
  'id' | 'displayName'
> {
  source: 'default' | 'preference' | 'preserved';
  /**
   * The router LLM's self-reported confidence that the user explicitly
   * requested this model. Only set when `source` is `'preference'`.
   */
  confidence?: number | null;
  /**
   * Present when the router LLM explicitly chose "no model mentioned"
   * (`__no_model__`). Carries its self-reported confidence in that choice so
   * router debug output can report the model decision on every routing.
   */
  noModelChoice?: {
    confidence: number | null;
  };
  /**
   * Present when the router LLM picked a model but the pick was demoted:
   * either its confidence was missing or below the preference threshold, or
   * the picked id was not in the deployment allow-list.
   */
  rejectedPick?: {
    id: string;
    displayName: string;
    confidence: number | null;
    reason: 'below_threshold' | 'not_allowed';
  };
}

export type RoutingSource =
  | SlackRoutingSource
  | TeamsRoutingSource
  | TelegramRoutingSource
  | DiscordRoutingSource
  | LinearRoutingSource
  | GitHubRoutingSource;

export interface SlackRoutingSource {
  type: 'slack';
  channelName?: string;
  threadMessages?: Array<{ text: string; user: string }>;
  images?: string[];
  videoDescriptions?: string[];
}

export interface TeamsRoutingSource {
  type: 'teams';
  teamName?: string;
  channelName?: string;
  threadMessages?: Array<{ text: string; user: string }>;
  images?: string[];
}

export interface TelegramRoutingSource {
  type: 'telegram';
  chatName?: string;
  threadMessages?: Array<{ text: string; user: string }>;
  images?: string[];
}

export interface DiscordRoutingSource {
  type: 'discord';
  guildName?: string;
  channelName?: string;
  threadMessages?: Array<{ text: string; user: string }>;
  images?: string[];
}

export interface LinearRoutingSource {
  type: 'linear';
  issueIdentifier: string;
  issueTitle: string;
  issueDescription?: string;
  projectName?: string;
  teamName?: string;
  guidance?: { system?: string; instructions?: string };
  previousComments?: Array<{ body: string; username?: string }>;
}

export interface GitHubRoutingSource {
  type: 'github';
  repository: string;
  headRefName?: string;
  prAuthorLogin?: string;
  issueOrPrTitle?: string;
  issueOrPrBody?: string;
  commentBody?: string;
}

type GitHubFollowUpMode = 'follow_up' | 'review';

export interface RoutableEnvironment {
  id: string;
  name: string;
  description?: string;
  repositoryNames: string[];
}

export type RoutingWorkspace =
  | { type: 'environment'; id: string; name: string }
  | { type: 'all_repositories' };

export type RoutingPhase = 'mcp' | 'direct' | 'platform' | 'fallback';

export interface RoutingDebugInfo {
  phase: RoutingPhase;
  toolsUsed: string[];
  needsExternalLookup: boolean | null;
  confidence?: number | null;
  workspaceRemapped?: boolean;
  selectedTaskModel?: RoutingTaskModelSelection;
}

/**
 * Shared integration policy for routed workspace suggestions.
 *
 * High-confidence environment matches may start immediately. Broad
 * all-repository routes, remapped workspaces, and lower-confidence matches
 * retain the normal correction window.
 */
export function getRoutingAutoConfirmDelayMs(
  routingDebug?: Pick<RoutingDebugInfo, 'confidence' | 'workspaceRemapped'>,
  workspaceType?: RoutingWorkspace['type'],
): number {
  return typeof routingDebug?.confidence === 'number' &&
    routingDebug.confidence >= ROUTING_IMMEDIATE_AUTO_CONFIRM_CONFIDENCE &&
    routingDebug.workspaceRemapped !== true &&
    workspaceType === 'environment'
    ? 0
    : ROUTING_AUTO_CONFIRM_TIMEOUT_MS;
}

export interface RoutingResult {
  workspace: RoutingWorkspace;
  model?: RoutingTaskModelSelection;
  reasoning: string;
  /**
   * Full short user-facing kickoff sentence generated with the routing decision.
   * Should naturally include the chosen environment (and model override when
   * the user requested one). Surfaces may post this directly when valid.
   */
  kickoffMessage?: string;
  requestedWorkKindDecision?: RequestedWorkKindDecision;
  /**
   * True when the router result should be presented as workspace-only because
   * the agent choice was fixed in code.
   */
  workspaceOnly?: boolean;
  debug?: RoutingDebugInfo;
}

export interface PlatformAnswerResult {
  answer: string;
  reasoning: string;
  debug?: RoutingDebugInfo;
}

export type RoutingDecision =
  | { status: 'routed'; result: RoutingResult }
  | { status: 'platform_answer'; result: PlatformAnswerResult }
  | { status: 'fallback'; reason: string; debug?: RoutingDebugInfo };

export interface GitHubRoutingResult {
  reasoning: string;
  followUpMode: GitHubFollowUpMode;
  debug?: RoutingDebugInfo;
}

export type GitHubRoutingDecision =
  | { status: 'routed'; result: GitHubRoutingResult }
  | { status: 'fallback'; reason: string; debug?: RoutingDebugInfo };

export interface WorkspaceResponse {
  workspaceValue: string;
  reasoning: string;
  confidence: number;
  /**
   * Short user-facing kickoff phrase generated with the routing decision.
   * Surfaces may turn this into the chat started message.
   */
  kickoffMessage?: string | null;
  needsExternalLookup: boolean;
  externalReference: string | null;
  requestedModelId?: string | null;
  modelConfidence?: number | null;
}

export type FollowUpIntent = 'confirm' | 'cancel' | 'correct';

export interface FollowUpClassification {
  intent: FollowUpIntent;
  reasoning: string;
}
