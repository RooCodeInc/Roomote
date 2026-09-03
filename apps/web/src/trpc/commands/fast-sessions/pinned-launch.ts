import { after } from 'next/server';

import { appendAttachmentTextsToPromptText } from '@roomote/cloud-agents';
import {
  DeploymentReadOnlyError,
  launchPinnedFastSessionTask,
  refreshFastAgentSessionTitle,
} from '@roomote/cloud-agents/server';
import { formatErrorForLog } from '@roomote/types';
import { db, environments, eq } from '@roomote/db/server';
import {
  ALL_REPOSITORIES,
  getUserDisplayName,
  resolveEvalHarnessSelection,
  TaskPayloadKind,
  type StandardTask,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { getRepositories } from '@/lib/server';
import {
  resolveEnvironmentSourceControlProvider,
  resolveSelectedRepositorySourceControlProvider,
} from '@/lib/server/source-control-provider';

import type { PinnedFastSessionLaunchInput } from './input';

type StartPinnedFastSessionLaunchInput = {
  text: string;
  images?: string[];
  attachmentTexts?: string[];
  /** Task model override; the deployment default applies when omitted. */
  model?: string | null;
  pinnedLaunch: PinnedFastSessionLaunchInput;
};

type StartPinnedFastSessionLaunchResult = {
  sessionId: string;
  fastConversationId: string;
  taskId: string;
};

function getPinnedRepositoryFullNames(
  pinnedLaunch: PinnedFastSessionLaunchInput,
): string[] {
  return pinnedLaunch.repo !== ALL_REPOSITORIES ? [pinnedLaunch.repo] : [];
}

async function describeLaunchTarget(
  pinnedLaunch: PinnedFastSessionLaunchInput,
): Promise<string> {
  if (pinnedLaunch.environmentId) {
    const environment = await db.query.environments.findFirst({
      where: eq(environments.id, pinnedLaunch.environmentId),
      columns: { name: true },
    });
    if (environment?.name) {
      return environment.name;
    }
  }
  return pinnedLaunch.repo === ALL_REPOSITORIES
    ? 'all repositories'
    : pinnedLaunch.repo;
}

/**
 * Starts a task whose workspace the person chose in the launcher. The owning
 * Session records the request and the delegation without a model turn, then
 * the task runs exactly as a Fast-delegated child would.
 */
export async function startPinnedFastSessionLaunch(
  auth: UserAuthSuccess,
  input: StartPinnedFastSessionLaunchInput,
): Promise<StartPinnedFastSessionLaunchResult> {
  const { pinnedLaunch } = input;

  const evalSelection = resolveEvalHarnessSelection({
    harness: pinnedLaunch.harness,
    model: input.model ?? undefined,
  });
  if (!evalSelection.ok) {
    throw new Error(evalSelection.error);
  }

  const selectedRepositoryFullNames =
    getPinnedRepositoryFullNames(pinnedLaunch);
  const availableRepositories =
    selectedRepositoryFullNames.length === 0 ? [] : await getRepositories(auth);
  const selectedRepositories = availableRepositories.filter((repository) =>
    selectedRepositoryFullNames.includes(repository.fullName),
  );
  const sourceControlProvider =
    resolveSelectedRepositorySourceControlProvider(
      selectedRepositories,
      selectedRepositoryFullNames,
    ) ??
    (await resolveEnvironmentSourceControlProvider(pinnedLaunch.environmentId));

  const text = input.text.trim();
  const description = appendAttachmentTextsToPromptText({
    text,
    attachmentTexts: input.attachmentTexts,
  });
  const blank = text.length === 0;

  const task: StandardTask = {
    harness: evalSelection.harness ?? pinnedLaunch.harness,
    computeProvider: pinnedLaunch.computeProvider,
    type: TaskPayloadKind.StandardTask,
    payload: {
      repo: pinnedLaunch.repo,
      ...(pinnedLaunch.branch ? { branch: pinnedLaunch.branch } : {}),
      ...(pinnedLaunch.sha ? { sha: pinnedLaunch.sha } : {}),
      ...(pinnedLaunch.environmentId
        ? { environmentId: pinnedLaunch.environmentId }
        : {}),
      ...(description.length > 0 ? { description } : {}),
      ...(input.images?.length ? { images: input.images } : {}),
      blank,
      ...(sourceControlProvider ? { sourceControlProvider } : {}),
      ...(evalSelection.harnessModelOverrides
        ? { harnessModelOverrides: evalSelection.harnessModelOverrides }
        : {}),
    },
  };

  const target = await describeLaunchTarget(pinnedLaunch);
  const kickoffMessage = blank
    ? `Opened a workspace in ${target}.`
    : `Started a task in ${target}.`;

  try {
    const launch = await launchPinnedFastSessionTask({
      userId: auth.userId,
      senderDisplayName:
        getUserDisplayName({ name: auth.name, email: auth.primaryEmail }) ??
        null,
      launchId: pinnedLaunch.launchId,
      prompt: text,
      images: input.images,
      task,
      surface: 'web',
      trigger: 'manual',
      kickoffMessage,
    });

    // No Fast turn runs for a pinned launch, so nothing else titles the
    // Session; derive one from the recorded request once the response is out.
    after(() =>
      refreshFastAgentSessionTitle({
        sessionId: launch.fastConversationId,
        userId: auth.userId,
      }).catch((error: unknown) => {
        console.error(
          `[startPinnedFastSessionLaunch] Failed to title Session ${launch.sessionId}: ${formatErrorForLog(error)}`,
        );
      }),
    );

    return {
      sessionId: launch.sessionId,
      fastConversationId: launch.fastConversationId,
      taskId: launch.taskId,
    };
  } catch (error) {
    if (error instanceof DeploymentReadOnlyError) {
      throw new Error(error.code);
    }
    throw error;
  }
}
