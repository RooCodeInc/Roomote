import { TaskPayloadKind } from '@roomote/types';

import type { RunTaskCallbacks } from '../run-task';

import { slackMentionCallbacks } from './slack-mention';
import { linearAgentCallbacks } from './linear-agent';
import { githubPrConflictResolveCallbacks } from './github-pr-conflict-resolve';

export const callbackMap: Record<TaskPayloadKind, RunTaskCallbacks> = {
  [TaskPayloadKind.StandardTask]: {},
  [TaskPayloadKind.Scan]: {},
  [TaskPayloadKind.McpRecommendations]: {},
  [TaskPayloadKind.GithubPrReview]: {},
  [TaskPayloadKind.GithubPrReviewSync]: {},
  [TaskPayloadKind.GithubPrReviewFollowUp]: {},
  [TaskPayloadKind.SlackAppMention]: slackMentionCallbacks,
  [TaskPayloadKind.LinearAgentSession]: linearAgentCallbacks,
  [TaskPayloadKind.SnapshotEnvironment]: {},
  [TaskPayloadKind.SnapshotResume]: {},
  [TaskPayloadKind.GithubPrConflictResolve]: githubPrConflictResolveCallbacks,
};
