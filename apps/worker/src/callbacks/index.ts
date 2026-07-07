import { CloudTaskType } from '@roomote/types';

import type { RunTaskCallbacks } from '../run-task';

import { slackMentionCallbacks } from './slack-mention';
import { linearAgentCallbacks } from './linear-agent';
import { githubPrConflictResolveCallbacks } from './github-pr-conflict-resolve';

export const callbackMap: Record<CloudTaskType, RunTaskCallbacks> = {
  [CloudTaskType.StandardTask]: {},
  [CloudTaskType.SuggestedTasks]: {},
  [CloudTaskType.McpRecommendations]: {},
  [CloudTaskType.LegacyOnboardingSuggestions]: {},
  [CloudTaskType.GithubIssueFix]: {},
  [CloudTaskType.GithubIssueCommentRespond]: {},
  [CloudTaskType.GithubPrReview]: {},
  [CloudTaskType.GithubPrReviewSync]: {},
  [CloudTaskType.GithubPrReviewFollowUp]: {},
  [CloudTaskType.SlackAppMention]: slackMentionCallbacks,
  [CloudTaskType.LinearAgentSession]: linearAgentCallbacks,
  [CloudTaskType.SnapshotEnvironment]: {},
  [CloudTaskType.SnapshotResume]: {},
  [CloudTaskType.GithubPrConflictResolve]: githubPrConflictResolveCallbacks,
};
