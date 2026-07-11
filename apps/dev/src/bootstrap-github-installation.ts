import { Command } from 'commander';

import { db, eq, type Repository, users } from '@roomote/db/server';
import { Env } from '@roomote/env';
import { syncGitHubInstallation } from '@roomote/github';

interface ScriptOptions {
  installationId: string;
  userId: string;
  appId?: string;
  repos?: string;
}

function parseArguments(): ScriptOptions {
  const program = new Command();

  program
    .name('bootstrap-github-installation')
    .description(
      'Bootstrap a GitHub installation and repository mappings after database reset',
    )
    .version('1.0.0')
    .requiredOption(
      '--installation-id <id>',
      'GitHub App installation ID (find at github.com/settings/installations)',
    )
    .requiredOption('--user-id <id>', 'user ID of the installing user')
    .option(
      '--app-id <id>',
      'GitHub App ID (defaults to R_GITHUB_APP_ID env var)',
    )
    .option(
      '--repos <names>',
      'Comma-separated list of repository names to filter (optional)',
    )
    .addHelpText(
      'after',
      `
Examples:
  pnpm --filter @roomote/dev bootstrap:github-installation \\
    --installation-id 12345678 \\
    --user-id user_abc123`,
    );

  program.parse(process.argv);

  return program.opts<ScriptOptions>();
}

async function main() {
  try {
    if (Env.NODE_ENV !== 'development') {
      throw new Error(
        'This script can only be run in development environment for security reasons',
      );
    }

    const { installationId, userId, appId, repos } = parseArguments();

    console.log('\nValidating inputs...\n');

    const installationIdNum = parseInt(installationId, 10);
    if (isNaN(installationIdNum)) {
      throw new Error(
        `Invalid installation ID: ${installationId}. Must be a number.`,
      );
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user || user.deletedAt) {
      throw new Error(`No active user found: ${userId}`);
    }

    console.log(`User found: ${user.name} (${user.email})`);

    if (appId) {
      const appIdNum = parseInt(appId, 10);
      if (isNaN(appIdNum)) {
        throw new Error(`Invalid app ID: ${appId}. Must be a number.`);
      }
      console.log(`App ID override requested: ${appId}`);
      console.log(
        'Note: App ID override is validated but sync uses R_GITHUB_APP_ID from env.',
      );
    }

    if (repos) {
      console.log(
        `Repository filter requested: ${repos}\nNote: Repository filtering is not currently implemented. All accessible repos will be synced.`,
      );
    }

    console.log('\nStarting GitHub installation sync...\n');

    const result = await syncGitHubInstallation({
      userId,
      installationId: installationIdNum,
    });

    if (!result.success) {
      throw new Error(result.error);
    }

    console.log('Successfully synced GitHub installation!\n');
    console.log('Installation Details:');
    console.log(`   ID: ${result.githubInstallation.id}`);
    console.log(
      `   Installation ID: ${result.githubInstallation.installationId}`,
    );
    console.log(`   Account: ${result.githubInstallation.accountLogin}`);
    console.log(`   Type: ${result.githubInstallation.accountType}`);
    if (result.githubInstallation.membersCount) {
      console.log(`   Members: ${result.githubInstallation.membersCount}`);
    }

    console.log(`\nSynced ${result.repositories.length} repositories:\n`);

    result.repositories.forEach((repo: Repository, index: number) => {
      console.log(`   ${index + 1}. ${repo.fullName}`);
      if (repo.description) {
        console.log(`      ${repo.description}`);
      }
    });

    console.log('\nBootstrap complete. You can now use these repositories.\n');

    process.exit(0);
  } catch (error) {
    console.error('\nError:', error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) {
      console.error('\nStack trace:', error.stack);
    }
    console.error('');
    process.exit(1);
  }
}

main();
