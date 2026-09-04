/**
 * Cloud Agents package - Server-side exports.
 *
 * This module exports server-side functionality including
 * the evaluator and cache that require database and Redis access.
 */

export * from '../index';
export { ROOMOTE_COMPACT_PROMPT } from '../compact-prompt';

export * from './cloud-agent-workflow';
export * from './task-url';
export * from './task-model-selection';
export * from './task-run-queue';
export * from './commit-author';
export { getPrBodyAttributionLine } from './workflows/utils';
export * from './repository-environment-coverage';
export * from './ci-failure-triage-prompt';
export * from './ci-failure-triage-types';
export * from './issue-fixer-prompt';

export * from './ci-failure-triage-claims';
export * from './automation-root-summary';
export * from './audio-transcription';
export * from './file-attachments';
export * from './fast-agent';
// Canonical API base URL fallback chain (explicit -> TRPC_URL -> R_APP_URL).
// Fast surfaces must derive apiBaseUrl through this so the broker's
// deployment-proxy origin check matches the resolver-built proxy URLs.
export { resolveApiBaseUrl } from './shared-utils';
export * from './github-message-instructions';
export * from './github-pr-follow-up-context';
export * from './untrusted-content';
export * from './workflows/githubPrReviewComment';
export * from './linked-task-relay';
export * from './llm-task-title';
export * from './mcp-self-setup';
export * from './mcp-tool-client';
export * from './non-task-provider-usage';
export {
  getAvailableEnvironments,
  type RoutableEnvironment,
  type RoutingWorkspace,
} from './available-environments';
export {
  evaluateChannelLaunchCriteria,
  type ChannelLaunchGateActivityEntry,
  type ChannelLaunchGateDecision,
} from './channel-launch-gate';
export {
  selectDiscordForumTag,
  type DiscordForumTagCandidate,
  type DiscordForumTagSelection,
} from './discord-forum-tag';
export { resolveRequestedWorkKindDecision } from './requested-work-kind';
export {
  getRouterMcpServerPolicy,
  getRouterMcpUpstreamConstraints,
  type RouterMcpServerId,
} from './mcp-policy';
export * from './slack-question-channel-suggestions';
export * from './suggested-tasks-prompt';
export * from './task-suggestion-prompts';
export * from './video-agent';
