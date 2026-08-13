import type {
  RequestedWorkKindDecision,
  WorkspaceRoutingSettings,
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
  routingRules?: WorkspaceRoutingSettings['rules'];
  routingActor?: {
    userId: string;
    apiBaseUrl?: string;
  };
  previousSuggestion?: {
    workspaceValue: string | null;
    workspaceDisplayName: string;
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
  reasoning: string;
  /**
   * Full short user-facing kickoff sentence generated with the routing decision.
   * Should naturally include the chosen environment. Surfaces may post this
   * directly when valid.
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

/**
 * Why a routing attempt ended in fallback. `model_decision` means the router
 * ran but declined to pick (ambiguous request, unmapped workspace);
 * `exception` means the routing infrastructure itself failed (provider error,
 * timeout) and surfaces should tell the user routing is unavailable rather
 * than silently showing the manual picker. Absent means `model_decision`.
 */
export type RoutingFallbackCause = 'exception' | 'model_decision';

export type RoutingDecision =
  | { status: 'routed'; result: RoutingResult }
  | { status: 'platform_answer'; result: PlatformAnswerResult }
  | {
      status: 'fallback';
      reason: string;
      cause?: RoutingFallbackCause;
      debug?: RoutingDebugInfo;
    };

export interface GitHubRoutingResult {
  reasoning: string;
  followUpMode: GitHubFollowUpMode;
  debug?: RoutingDebugInfo;
}

export type GitHubRoutingDecision =
  | { status: 'routed'; result: GitHubRoutingResult }
  | {
      status: 'fallback';
      reason: string;
      cause?: RoutingFallbackCause;
      debug?: RoutingDebugInfo;
    };

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
}

export type FollowUpIntent = 'confirm' | 'cancel' | 'correct';

export interface FollowUpClassification {
  intent: FollowUpIntent;
  reasoning: string;
}
