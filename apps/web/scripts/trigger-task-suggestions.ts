#!/usr/bin/env tsx

import {
  db,
  deploymentSettings,
  eq,
  isNull,
  users,
  workItems,
} from '@roomote/db/server';
import { FeatureFlag } from '@roomote/feature-flags';
import { normalizeSetupNewState } from '@roomote/types';

import type { UserAuthSuccess } from '../src/types';
import { triggerTaskSuggestionsCommand } from '../src/trpc/commands/task-suggestions';

function readArg(name: string): string | null {
  const flag = `--${name}`;
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);

  if (index < 0 || index + 1 >= args.length) {
    return null;
  }

  return args[index + 1] ?? null;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function printUsage(): void {
  console.log(`Usage:
  pnpm exec dotenvx run -f .env.local -- pnpm --filter @roomote/web exec tsx scripts/trigger-task-suggestions.ts [--email <email>] [--force]`);
}

async function forceResetTaskSuggestions(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(workItems).where(eq(workItems.kind, 'suggestion'));

    const [settings] = await tx
      .select({ setupNewState: deploymentSettings.setupNewState })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'))
      .limit(1);

    const setupNewState = normalizeSetupNewState(settings?.setupNewState);
    const nextSetupState = normalizeSetupNewState({
      ...setupNewState,
      suggestionTaskId: null,
      suggestionTaskStartedAt: null,
      suggestionGenerationTriggeredAt: null,
    });

    await tx
      .insert(deploymentSettings)
      .values({
        id: 'default',
        setupNewState: nextSetupState,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: {
          setupNewState: nextSetupState,
          updatedAt: new Date(),
        },
      });
  });
}

async function resolveUser(email: string | null) {
  return email
    ? db.query.users.findFirst({
        where: eq(users.email, email),
      })
    : db.query.users.findFirst({
        where: isNull(users.deletedAt),
      });
}

function buildAuth(user: typeof users.$inferSelect): UserAuthSuccess {
  const email = user.email ?? '';
  const username = email.split('@')[0] || user.id;
  const name = user.name || username;

  return {
    success: true,
    userType: 'user',
    userId: user.id,
    isAdmin: true,
    name,
    primaryEmail: email,
    featureFlags: {} as Record<FeatureFlag, boolean>,
    anonymousAnalyticsEnabled: false,
    resource: {
      username,
      fullName: name,
      firstName: name,
      lastName: null,
      primaryEmailAddress: {
        id: `${user.id}-email`,
        emailAddress: email,
      },
      emailAddresses: [
        {
          id: `${user.id}-email`,
          emailAddress: email,
        },
      ],
      imageUrl: user.imageUrl ?? '',
      createdAt: user.createdAt,
    },
  };
}

async function main(): Promise<void> {
  if (hasFlag('help')) {
    printUsage();
    return;
  }

  const email = readArg('email');
  const force = hasFlag('force');
  const user = await resolveUser(email);

  if (!user || user.deletedAt) {
    console.error(
      email ? `No active user found for ${email}` : 'No active user found.',
    );
    process.exit(1);
  }

  if (force) {
    await forceResetTaskSuggestions();
  }

  const result = await triggerTaskSuggestionsCommand(buildAuth(user));

  console.log(
    JSON.stringify(
      {
        userId: user.id,
        generationStatus: result.generationStatus,
        triggered: result.triggered,
        taskId: result.taskId ?? null,
        force,
      },
      null,
      2,
    ),
  );
}

void main();
