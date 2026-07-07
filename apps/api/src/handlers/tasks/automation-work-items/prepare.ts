import crypto from 'node:crypto';

import { db, environments, inArray } from '@roomote/db/server';
import type {
  AutomationWorkItemDisposition,
  WorkspaceReadiness,
} from '@roomote/types';
import type { AutomationWorkItemInput } from './schema.js';
import type {
  PreparedAutomationWorkItem,
  ResolvedRepository,
} from './types.js';

export class AutomationWorkItemValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationWorkItemValidationError';
  }
}

function automationWorkItemValidationError(message: string): never {
  throw new AutomationWorkItemValidationError(message);
}

function buildDefaultBareRepoReadinessMessage(
  targetRepositoryFullName: string,
): string {
  return `I can inspect and edit \`${targetRepositoryFullName}\`, but full app or service validation may be limited until this repo is added to an environment.`;
}

function buildAutomationWorkItemFingerprint(params: {
  actionKind: string;
  disposition: AutomationWorkItemDisposition;
  title: string;
  brief: string;
  targetRepositoryFullName: string | null;
  repositoryIds: string[];
  explicitFingerprint?: string | null;
}): string {
  const explicitFingerprint = params.explicitFingerprint?.trim();

  if (explicitFingerprint) {
    return explicitFingerprint;
  }

  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        actionKind: params.actionKind,
        disposition: params.disposition,
        title: params.title,
        brief: params.brief,
        targetRepositoryFullName: params.targetRepositoryFullName,
        repositoryIds: [...params.repositoryIds].sort(),
      }),
    )
    .digest('hex');
}

function prepareAutomationWorkItem(params: {
  workItem: AutomationWorkItemInput;
  repositoryIds: string[];
  candidateRepositorySet: Set<string>;
  environmentsById: Map<string, { id: string; config: unknown }>;
}): PreparedAutomationWorkItem {
  const { workItem, candidateRepositorySet, environmentsById } = params;
  const targetRepositoryFullName =
    workItem.targetRepositoryFullName?.trim() || null;
  const targetEnvironmentId = workItem.targetEnvironmentId ?? null;
  const explicitReadiness = workItem.workspaceReadiness ?? null;
  const readinessMessage = workItem.readinessMessage?.trim() || null;

  if (
    targetRepositoryFullName &&
    !candidateRepositorySet.has(targetRepositoryFullName)
  ) {
    automationWorkItemValidationError(
      `Work item "${workItem.title}" targets repository "${targetRepositoryFullName}", which is not part of this automation run.`,
    );
  }

  if (targetEnvironmentId && !targetRepositoryFullName) {
    automationWorkItemValidationError(
      `Work item "${workItem.title}" includes targetEnvironmentId without targetRepositoryFullName.`,
    );
  }

  if (workItem.disposition === 'act' && !workItem.executionPrompt?.trim()) {
    automationWorkItemValidationError(
      `Work item "${workItem.title}" must include executionPrompt when disposition is act.`,
    );
  }

  if (workItem.disposition === 'act' && !targetRepositoryFullName) {
    automationWorkItemValidationError(
      `Work item "${workItem.title}" must include targetRepositoryFullName when disposition is act.`,
    );
  }

  if (workItem.disposition === 'act' && !targetEnvironmentId) {
    automationWorkItemValidationError(
      `Work item "${workItem.title}" must include targetEnvironmentId.`,
    );
  }

  if (!targetRepositoryFullName) {
    if (targetEnvironmentId || explicitReadiness || readinessMessage) {
      automationWorkItemValidationError(
        `Work item "${workItem.title}" must include targetRepositoryFullName when launch metadata is provided.`,
      );
    }

    return {
      title: workItem.title,
      brief: workItem.brief,
      category: workItem.category ?? null,
      priority: workItem.priority ?? null,
      actionKind: workItem.actionKind,
      disposition: workItem.disposition,
      investigationContext: workItem.investigationContext?.trim() || null,
      executionPrompt: workItem.executionPrompt?.trim() || null,
      fingerprint: buildAutomationWorkItemFingerprint({
        actionKind: workItem.actionKind,
        disposition: workItem.disposition,
        title: workItem.title,
        brief: workItem.brief,
        targetRepositoryFullName: null,
        repositoryIds: params.repositoryIds,
        explicitFingerprint: workItem.fingerprint ?? null,
      }),
      targetRepositoryFullName: null,
      targetEnvironmentId: null,
      workspaceReadiness: null,
      readinessMessage: null,
    };
  }

  if (targetEnvironmentId) {
    const environment = environmentsById.get(targetEnvironmentId);

    if (!environment) {
      automationWorkItemValidationError(
        `Work item "${workItem.title}" targets missing environment "${targetEnvironmentId}".`,
      );
    } else {
      const configuredRepositories =
        environment.config &&
        typeof environment.config === 'object' &&
        'repositories' in environment.config &&
        Array.isArray(environment.config.repositories)
          ? environment.config.repositories
          : [];

      const includesTargetRepository = configuredRepositories.some(
        (repository) =>
          repository?.repository?.toLowerCase?.() ===
          targetRepositoryFullName.toLowerCase(),
      );

      if (!includesTargetRepository) {
        automationWorkItemValidationError(
          `Work item "${workItem.title}" targets environment "${targetEnvironmentId}", but that environment does not include "${targetRepositoryFullName}".`,
        );
      }
    }
  }

  const workspaceReadiness: WorkspaceReadiness =
    explicitReadiness ??
    (targetEnvironmentId ? 'environment_backed' : 'bare_repo');

  if (workspaceReadiness === 'environment_backed' && !targetEnvironmentId) {
    automationWorkItemValidationError(
      `Work item "${workItem.title}" marked as environment_backed is missing targetEnvironmentId.`,
    );
  }

  if (workspaceReadiness === 'bare_repo' && targetEnvironmentId) {
    automationWorkItemValidationError(
      `Work item "${workItem.title}" marked as bare_repo cannot also include targetEnvironmentId.`,
    );
  }

  if (
    workItem.disposition === 'act' &&
    workspaceReadiness !== 'environment_backed'
  ) {
    automationWorkItemValidationError(
      `Work item "${workItem.title}" must stay environment-backed.`,
    );
  }

  return {
    title: workItem.title,
    brief: workItem.brief,
    category: workItem.category ?? null,
    priority: workItem.priority ?? null,
    actionKind: workItem.actionKind,
    disposition: workItem.disposition,
    investigationContext: workItem.investigationContext?.trim() || null,
    executionPrompt: workItem.executionPrompt?.trim() || null,
    fingerprint: buildAutomationWorkItemFingerprint({
      actionKind: workItem.actionKind,
      disposition: workItem.disposition,
      title: workItem.title,
      brief: workItem.brief,
      targetRepositoryFullName,
      repositoryIds: params.repositoryIds,
      explicitFingerprint: workItem.fingerprint ?? null,
    }),
    targetRepositoryFullName,
    targetEnvironmentId,
    workspaceReadiness,
    readinessMessage:
      workspaceReadiness === 'bare_repo'
        ? (readinessMessage ??
          buildDefaultBareRepoReadinessMessage(targetRepositoryFullName))
        : null,
  };
}

export async function resolvePreparedAutomationWorkItems(params: {
  workItems: AutomationWorkItemInput[];
  candidateRepositories: ResolvedRepository[];
}): Promise<PreparedAutomationWorkItem[]> {
  const candidateRepositorySet = new Set(
    params.candidateRepositories.map((repository) => repository.fullName),
  );
  const repositoryIds = params.candidateRepositories.map(
    (repository) => repository.id,
  );
  const targetEnvironmentIds = [
    ...new Set(
      params.workItems
        .map((workItem) => workItem.targetEnvironmentId)
        .filter((environmentId): environmentId is string =>
          Boolean(environmentId),
        ),
    ),
  ];

  const environmentsById =
    targetEnvironmentIds.length === 0
      ? new Map<string, { id: string; config: unknown }>()
      : new Map(
          (
            await db
              .select({
                id: environments.id,
                config: environments.config,
              })
              .from(environments)
              .where(inArray(environments.id, targetEnvironmentIds))
          ).map((environment) => [environment.id, environment]),
        );

  return params.workItems.map((workItem) =>
    prepareAutomationWorkItem({
      workItem,
      repositoryIds,
      candidateRepositorySet,
      environmentsById,
    }),
  );
}
