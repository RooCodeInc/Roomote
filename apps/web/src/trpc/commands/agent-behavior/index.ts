import {
  backgroundAgentSettings,
  db,
  eq,
  findLatestGithubIdentityForUser,
  getBackgroundAgentSettingsForDeployment,
  isNull,
  repositories,
  users,
} from '@roomote/db/server';
import { compileAuthorshipRules } from '@roomote/cloud-agents/server';
import type {
  AuthorshipRuleActor,
  AuthorshipRuleIssue,
  CompiledAuthorshipRule,
} from '@roomote/types';
import { getUserDisplayName } from '@roomote/types';
import { FeatureFlag } from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';

function assertAdmin(auth: UserAuthSuccess): asserts auth is UserAuthSuccess {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

function normalizeOptionalText(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

async function listAvailableAuthorshipRepositories() {
  const rows = await db
    .select({
      fullName: repositories.fullName,
    })
    .from(repositories)
    .where(eq(repositories.isActive, true));

  return [...new Set(rows.map((row) => row.fullName).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

async function listAvailableAuthorshipUsers(): Promise<AuthorshipRuleActor[]> {
  const rows = await db
    .select({
      userId: users.id,
      userName: users.name,
      userEmail: users.email,
    })
    .from(users)
    .where(isNull(users.deletedAt));

  const identities = await Promise.all(
    rows.map(async (row): Promise<AuthorshipRuleActor | null> => {
      const githubIdentity = await findLatestGithubIdentityForUser(
        db,
        row.userId,
      );

      if (!githubIdentity.githubLogin) {
        return null;
      }

      return {
        userId: row.userId,
        displayName:
          getUserDisplayName({
            name: row.userName,
            email: row.userEmail,
          }) ?? row.userId,
        githubLogin: githubIdentity.githubLogin,
        githubUserId: githubIdentity.githubUserId,
      };
    }),
  );

  return identities
    .filter((value): value is AuthorshipRuleActor => Boolean(value))
    .sort((left, right) => {
      const leftLabel =
        left.displayName ?? left.githubLogin ?? left.userId ?? '';
      const rightLabel =
        right.displayName ?? right.githubLogin ?? right.userId ?? '';

      return leftLabel.localeCompare(rightLabel);
    });
}

function findInvalidSpecificAuthorRule(
  rules: CompiledAuthorshipRule[],
): CompiledAuthorshipRule | null {
  return (
    rules.find(
      (rule) =>
        rule.author.mode === 'specific_user' &&
        (!normalizeOptionalText(rule.author.actor.githubLogin) ||
          typeof rule.author.actor.githubUserId !== 'number'),
    ) ?? null
  );
}

export async function getAgentBehaviorSettingsCommand(
  auth: UserAuthSuccess,
): Promise<{
  globalAgentInstructions: string | null;
  authorshipInstructions: string | null;
  compiledAuthorshipRules: CompiledAuthorshipRule[];
  compiledAuthorshipIssues: AuthorshipRuleIssue[];
  compiledAuthorshipAt: Date | null;
}> {
  assertAdmin(auth);

  const settings = await getBackgroundAgentSettingsForDeployment();

  return {
    globalAgentInstructions: settings.globalAgentInstructions ?? null,
    authorshipInstructions: settings.authorshipInstructions ?? null,
    compiledAuthorshipRules: settings.compiledAuthorshipRules ?? [],
    compiledAuthorshipIssues: settings.compiledAuthorshipIssues ?? [],
    compiledAuthorshipAt: settings.compiledAuthorshipAt ?? null,
  };
}

export async function updateAgentBehaviorSettingsCommand(
  auth: UserAuthSuccess,
  input: {
    globalAgentInstructions?: string | null;
    authorshipInstructions?: string | null;
  },
): Promise<
  | {
      success: true;
      settings: {
        globalAgentInstructions: string | null;
        authorshipInstructions: string | null;
        compiledAuthorshipRules: CompiledAuthorshipRule[];
        compiledAuthorshipIssues: AuthorshipRuleIssue[];
        compiledAuthorshipAt: Date | null;
      };
    }
  | {
      success: false;
      fieldErrors: {
        globalAgentInstructions?: string;
        authorshipInstructions?: string;
      };
    }
> {
  assertAdmin(auth);

  // Defense in depth for the AuthorshipRules rollout: the settings surface is
  // hidden when the org flag is off, but the write path must also ignore any
  // authorship input so a stale client cannot compile or persist rules.
  const authorshipRulesEnabled =
    auth.featureFlags[FeatureFlag.AuthorshipRules] === true;
  const authorshipInstructionsProvided =
    authorshipRulesEnabled && input.authorshipInstructions !== undefined;

  if ((input.globalAgentInstructions?.length ?? 0) > 10_000) {
    return {
      success: false,
      fieldErrors: {
        globalAgentInstructions: 'Global agent instructions are too long.',
      },
    };
  }

  if (
    authorshipInstructionsProvided &&
    (input.authorshipInstructions?.length ?? 0) > 10_000
  ) {
    return {
      success: false,
      fieldErrors: {
        authorshipInstructions: 'Authorship rules are too long.',
      },
    };
  }

  const existingSettings = await getBackgroundAgentSettingsForDeployment();
  const globalAgentInstructions =
    input.globalAgentInstructions === undefined
      ? (existingSettings.globalAgentInstructions ?? null)
      : normalizeOptionalText(input.globalAgentInstructions);
  const authorshipInstructions = authorshipInstructionsProvided
    ? normalizeOptionalText(input.authorshipInstructions)
    : (existingSettings.authorshipInstructions ?? null);
  const now = new Date();

  let compiledAuthorshipRules = existingSettings.compiledAuthorshipRules ?? [];
  let compiledAuthorshipIssues =
    existingSettings.compiledAuthorshipIssues ?? [];
  let compiledAuthorshipAt = existingSettings.compiledAuthorshipAt ?? null;

  if (authorshipInstructionsProvided) {
    try {
      const [availableRepositories, availableUsers] = await Promise.all([
        listAvailableAuthorshipRepositories(),
        listAvailableAuthorshipUsers(),
      ]);

      const compiled = await compileAuthorshipRules({
        authorshipInstructions: authorshipInstructions ?? '',
        availableRepositories,
        availableUsers,
        userId: auth.userId,
      });

      const invalidSpecificAuthorRule = findInvalidSpecificAuthorRule(
        compiled.rules,
      );
      if (invalidSpecificAuthorRule) {
        return {
          success: false,
          fieldErrors: {
            authorshipInstructions: `Rule "${invalidSpecificAuthorRule.label}" names a specific author who does not have a complete linked GitHub identity yet.`,
          },
        };
      }

      compiledAuthorshipRules = compiled.rules;
      compiledAuthorshipIssues = compiled.issues;
      compiledAuthorshipAt = now;
    } catch {
      return {
        success: false,
        fieldErrors: {
          authorshipInstructions:
            'Roomote could not compile those authorship rules right now.',
        },
      };
    }
  }

  await db
    .insert(backgroundAgentSettings)
    .values({
      id: 'default',
      globalAgentInstructions,
      ...(authorshipInstructionsProvided
        ? {
            authorshipInstructions,
            compiledAuthorshipRules,
            compiledAuthorshipIssues,
            compiledAuthorshipAt,
          }
        : {}),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: backgroundAgentSettings.id,
      set: {
        globalAgentInstructions,
        ...(authorshipInstructionsProvided
          ? {
              authorshipInstructions,
              compiledAuthorshipRules,
              compiledAuthorshipIssues,
              compiledAuthorshipAt,
            }
          : {}),
        updatedAt: now,
      },
    });

  return {
    success: true,
    settings: {
      globalAgentInstructions,
      authorshipInstructions,
      compiledAuthorshipRules,
      compiledAuthorshipIssues,
      compiledAuthorshipAt,
    },
  };
}
