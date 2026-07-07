/**
 * LLM Router module for automatic task routing.
 */

export type {
  RoutingContext,
  RoutingSource,
  SlackRoutingSource,
  TeamsRoutingSource,
  TelegramRoutingSource,
  LinearRoutingSource,
  GitHubRoutingSource,
  GitHubRoutingResult,
  GitHubRoutingDecision,
  RoutableAgent,
  RoutableEnvironment,
  RoutingWorkspace,
  RoutingPhase,
  RoutingDebugInfo,
  RoutingResult,
  PlatformAnswerResult,
  RoutingDecision,
  FollowUpIntent,
  FollowUpClassification,
} from './types';

export type { RouterMcpServerId } from './mcp-policy';
export type {
  SlackMcpSetupDetectionActor,
  SlackMcpSetupRequirement,
} from './slack-mcp-setup';

export {
  SLACK_AUTO_CONFIRM_TIMEOUT_MS,
  LINEAR_AUTO_CONFIRM_TIMEOUT_MS,
  ROOMOTE_SMALL_MODEL_LABEL,
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_THREAD_MESSAGES,
} from './types';

export { routeTask, routeGitHubTask, classifyFollowUp } from './router-service';
export { evaluateChannelLaunchCriteria } from './channel-launch-gate';
export type {
  ChannelLaunchGateActivityEntry,
  ChannelLaunchGateDecision,
} from './channel-launch-gate';
export {
  detectSlackMcpSetupRequirement,
  extractUrlsFromSlackText,
  matchSlackMcpSetupService,
} from './slack-mcp-setup';

export {
  classifyRequestedWorkKindFromPrompt,
  getExplicitBootstrapRequestedWorkKindDecision,
  getInheritedRequestedWorkKindDecision,
  getSystemDefaultRequestedWorkKindDecision,
  getTaskToolRequestedWorkKindDecision,
  resolveRequestedWorkKindDecision,
} from './requested-work-kind';

export {
  getRouterMcpServerPolicy,
  getRouterMcpUpstreamConstraints,
} from './mcp-policy';

export type {
  SlackContextParams,
  TeamsContextParams,
  TelegramContextParams,
  LinearContextParams,
  GitHubContextParams,
} from './context-builders';

export {
  buildSlackRoutingContext,
  buildTeamsRoutingContext,
  buildTelegramRoutingContext,
  buildLinearRoutingContext,
  buildGitHubRoutingContext,
  getAvailableEnvironments,
  NON_ROUTABLE_AGENT_TYPES,
  GITHUB_ONLY_AGENT_TYPES,
} from './context-builders';
