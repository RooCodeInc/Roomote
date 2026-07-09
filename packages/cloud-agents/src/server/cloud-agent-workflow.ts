import {
  type CloudTask,
  TaskPayloadKind,
  getCommunicationChannelFromTaskPayload,
  getCommunicationMessageIdFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationTenantIdFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  getSkillCommandDelimiter,
  getSlackChannelFromTaskPayload,
  getSlackTeamDomainFromTaskPayload,
  getSlackThreadTsFromTaskPayload,
  resolveSourceControlProviderFromPayload,
} from '@roomote/types';
import {
  FeatureFlag,
  getFeatureFlagEvaluator,
} from '@roomote/feature-flags/server';
import {
  type CloudJob,
  db,
  eq,
  tasks,
  getBackgroundAgentSettings,
  DEFAULT_CONFLICT_RESOLVER_LABEL,
  getDeploymentPrAction,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import { getRedis } from '@roomote/redis';

import { githubPrReview } from './workflows/githubPrReview';
import { githubPrReviewSync } from './workflows/githubPrReviewSync';
import { githubPrReviewFollowUp } from './workflows/githubPrReviewFollowUp';
import { standardTask } from './workflows/standardTask';
import {
  buildChatProviderMessageInstructions,
  buildSlackMessageInstructions,
  buildTeamsMessageInstructions,
  slackAppMention,
} from './workflows/slackAppMention';
import { linearAgentSession } from './workflows/linearAgentSession';
import { githubPrConflictResolve } from './workflows/githubPrConflictResolve';
import { getWorkspaceRepositoryFullNames } from './workflows/utils';
import {
  DEFAULT_ROOMOTE_COMMIT_AUTHOR,
  resolveTaskCommitAuthor,
} from './commit-author';

import { getTaskUrl } from './cloud-job-id-coder';

export async function generatePrompt({
  cloudJob,
  cloudTask,
  gitHubToken,
}: {
  cloudJob: CloudJob;
  cloudTask: CloudTask;
  gitHubToken: string;
}): Promise<{
  prompt: string;
  harnessInstructions?: string;
  artifacts: Record<string, unknown>;
}> {
  const cloudJobUrl = getTaskUrl({
    taskId: cloudJob.taskId,
    utm: { campaign: cloudJob.payloadKind, source: 'github-comment' },
  });

  const taskRow = await db.query.tasks.findFirst({
    where: eq(tasks.id, cloudJob.taskId),
    columns: {
      commitAuthorKind: true,
      commitAuthorUserId: true,
      commitAuthorLogin: true,
      commitAuthorExternalId: true,
      prAssigneeLogin: true,
      actorDisplayName: true,
      slackThreadTs: true,
    },
  });
  const commitAuthor = taskRow
    ? await resolveTaskCommitAuthor(db, taskRow)
    : DEFAULT_ROOMOTE_COMMIT_AUTHOR;
  const { conflictResolverFrequency, conflictResolverLabel } =
    await getBackgroundAgentSettings().catch(() => ({
      conflictResolverFrequency: 'every_6_hours' as const,
      conflictResolverLabel: DEFAULT_CONFLICT_RESOLVER_LABEL,
    }));
  const enabledConflictResolverLabel =
    conflictResolverFrequency === 'off' ? undefined : conflictResolverLabel;
  const featureFlagEvaluator = getFeatureFlagEvaluator(getRedis());
  const evaluateOrgFeatureFlag = async (flag: FeatureFlag) =>
    await featureFlagEvaluator
      .evaluate(flag, {
        isDeploymentContext: false,
        userId: cloudJob.actingUserId ?? 'deployment',
      })
      .catch(() => false);
  const visualProofAutoScreencastEnabled = await evaluateOrgFeatureFlag(
    FeatureFlag.VisualProofAutoScreencast,
  );
  const backgroundProofCaptureEnabled = await evaluateOrgFeatureFlag(
    FeatureFlag.BackgroundSubagents,
  );
  const prAction = await getDeploymentPrAction().catch(() => undefined);

  switch (cloudTask.type) {
    // <Agent: PR Reviewer, Trigger: GitHub>
    case TaskPayloadKind.GithubPrReview:
      return githubPrReview({
        cloudTask,
        gitHubToken,
        cloudJobUrl,
        attribution: commitAuthor,
        visualProofAutoScreencastEnabled,
        backgroundProofCaptureEnabled,
      });
    case TaskPayloadKind.GithubPrReviewSync:
      return githubPrReviewSync({
        cloudJobId: cloudJob.id,
        cloudTask,
        gitHubToken,
        cloudJobUrl,
        attribution: commitAuthor,
        visualProofAutoScreencastEnabled,
        backgroundProofCaptureEnabled,
      });

    // <Agent: PR Reviewer follow-up, Trigger: GitHub>
    case TaskPayloadKind.GithubPrReviewFollowUp:
      return githubPrReviewFollowUp({
        cloudTask,
        gitHubToken,
        cloudJobUrl,
        attribution: commitAuthor,
        visualProofAutoScreencastEnabled,
        backgroundProofCaptureEnabled,
      });

    // <Agent: Fixer, Trigger: GitHub (conflict resolution)>
    case TaskPayloadKind.GithubPrConflictResolve:
      return githubPrConflictResolve({
        cloudTask,
        cloudJobUrl,
        attribution: commitAuthor,
        visualProofAutoScreencastEnabled,
        backgroundProofCaptureEnabled,
      });

    // <Agent: Generalist, Trigger: Slack>
    case TaskPayloadKind.SlackAppMention: {
      return slackAppMention({
        cloudTask,
        repoFullNames: await getWorkspaceRepositoryFullNames(cloudTask),
        conflictResolverLabel: enabledConflictResolverLabel,
        cloudJobUrl,
        attribution: commitAuthor,
        visualProofAutoScreencastEnabled,
        backgroundProofCaptureEnabled,
        prAction,
      });
    }

    // <Agent: Generalist, Trigger: Linear>
    case TaskPayloadKind.LinearAgentSession:
      return linearAgentSession({
        cloudTask,
        repoFullNames: await getWorkspaceRepositoryFullNames(cloudTask),
        conflictResolverLabel: enabledConflictResolverLabel,
        cloudJobUrl,
        attribution: commitAuthor,
        visualProofAutoScreencastEnabled,
        backgroundProofCaptureEnabled,
        prAction,
      });

    // <Agent: Generalist, Trigger: Manual>
    case TaskPayloadKind.StandardTask:
    case TaskPayloadKind.Scan:
    case TaskPayloadKind.McpRecommendations: {
      const baseDescription = cloudTask.payload.description;
      if (!baseDescription) {
        throw new Error(`Description is required for ${cloudTask.type}`);
      }

      const bootstrapSkill = cloudTask.payload.bootstrap?.skill;
      const baseDescriptionWithBootstrap = bootstrapSkill
        ? `${getSkillCommandDelimiter(cloudTask.harness)}${bootstrapSkill}\n${baseDescription}`
        : baseDescription;

      // When the description starts with an explicit skill invocation —
      // either prepended by `bootstrap.skill` or typed directly into a
      // Slack Workflow `start_roomote_task` payload — forward the
      // structured request format so standardTask's matcher can keep the
      // `$skill` / `/skill` prefix outside the `<request>` wrapper as an
      // authoritative initial skill selection. Neutralize only the literal
      // `</request>` sequence that could prematurely close the wrapper;
      // leave other angle-bracketed content (e.g. `<task_context>`,
      // `<source>`, `<intended_outcome>` blocks supplied by chore-lab
      // Slack Workflow templates) untouched so structured metadata still
      // reaches the skill verbatim.
      const skillPrefixMatch = baseDescriptionWithBootstrap.match(
        /^([$/][A-Za-z0-9._-]+)(?:\n([\s\S]*))?$/,
      );
      const description = skillPrefixMatch
        ? (() => {
            const command = skillPrefixMatch[1] ?? '';
            const body = skillPrefixMatch[2] ?? '';
            const safeBody = body.replaceAll('</request>', '&lt;/request&gt;');
            return safeBody ? `${command}\n${safeBody}` : command;
          })()
        : baseDescriptionWithBootstrap;
      const requestFormat: 'plain' | 'structured' | undefined = skillPrefixMatch
        ? 'structured'
        : undefined;
      const slackChannel = getSlackChannelFromTaskPayload(cloudTask.payload);
      const communicationProvider = getCommunicationProviderFromTaskPayload(
        cloudTask.payload,
      );
      const nonSlackChatProvider =
        communicationProvider === 'teams' ||
        communicationProvider === 'telegram'
          ? communicationProvider
          : null;
      const slackThreadTs =
        getSlackThreadTsFromTaskPayload(cloudTask.payload) ??
        taskRow?.slackThreadTs ??
        null;
      // Telegram and Teams persist generic conversation ids on the payload;
      // resolve them into the surface-specific fields the PR provenance line
      // needs to deep-link back to the originating chat message.
      const communicationChannelId = getCommunicationChannelFromTaskPayload(
        cloudTask.payload,
      );
      const communicationThreadId = getCommunicationThreadIdFromTaskPayload(
        cloudTask.payload,
      );
      const communicationMessageId = getCommunicationMessageIdFromTaskPayload(
        cloudTask.payload,
      );
      const teamsTenantId = getCommunicationTenantIdFromTaskPayload(
        cloudTask.payload,
      );

      const result = standardTask({
        description,
        repo: cloudTask.payload.repo,
        repoFullNames: await getWorkspaceRepositoryFullNames(cloudTask),
        taskSurface: slackChannel
          ? 'slack'
          : nonSlackChatProvider
            ? nonSlackChatProvider
            : 'web',
        conflictResolverLabel: enabledConflictResolverLabel,
        cloudJobUrl,
        attribution: commitAuthor,
        slackTeamDomain:
          getSlackTeamDomainFromTaskPayload(cloudTask.payload) ?? undefined,
        slackChannel: slackChannel ?? undefined,
        slackThreadTs: slackThreadTs ?? undefined,
        telegramChatId:
          nonSlackChatProvider === 'telegram'
            ? (communicationChannelId ?? undefined)
            : undefined,
        telegramThreadId:
          nonSlackChatProvider === 'telegram'
            ? (communicationThreadId ?? undefined)
            : undefined,
        telegramMessageId:
          nonSlackChatProvider === 'telegram'
            ? (communicationMessageId ?? undefined)
            : undefined,
        telegramBotUsername:
          nonSlackChatProvider === 'telegram'
            ? (Env.TELEGRAM_BOT_USERNAME ?? undefined)
            : undefined,
        teamsConversationId:
          nonSlackChatProvider === 'teams'
            ? (communicationChannelId ?? undefined)
            : undefined,
        teamsMessageId:
          nonSlackChatProvider === 'teams'
            ? (communicationMessageId ?? undefined)
            : undefined,
        teamsTenantId: teamsTenantId ?? undefined,
        teamsBotAppId:
          nonSlackChatProvider === 'teams'
            ? (Env.TEAMS_BOT_APP_ID ?? undefined)
            : undefined,
        interactiveMode: cloudTask.payload.bootstrap?.interactiveMode,
        requestFormat,
        linkedWorkItems: cloudTask.payload.linkedWorkItems,
        visualProofAutoScreencastEnabled,
        backgroundProofCaptureEnabled,
        sourceControlProvider: resolveSourceControlProviderFromPayload(
          cloudTask.payload,
        ),
        prAction,
      });

      if (slackChannel && slackThreadTs) {
        const slackInstructions = buildSlackMessageInstructions({
          includeRequestUserInputGuidance: true,
        });
        result.harnessInstructions = result.harnessInstructions
          ? `${slackInstructions}\n\n${result.harnessInstructions}`
          : slackInstructions;
      }

      if (nonSlackChatProvider) {
        const chatInstructions =
          nonSlackChatProvider === 'teams'
            ? buildTeamsMessageInstructions()
            : buildChatProviderMessageInstructions(nonSlackChatProvider);
        result.harnessInstructions = result.harnessInstructions
          ? `${chatInstructions}\n\n${result.harnessInstructions}`
          : chatInstructions;
      }

      return result;
    }

    default:
      throw new Error(`Unsupported cloud task type: ${cloudTask.type}`);
  }
}
