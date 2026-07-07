import { Command } from 'commander';

import { resolveAppEnv } from '@roomote/env';

import { seedDemoData } from './seed-demo-data';

interface ScriptOptions {
  force?: boolean;
}

/**
 * Detects whether the current process is running inside a Roomote task
 * sandbox. `ROOMOTE_SANDBOX_SERVER_HOST` is injected into every sandbox's
 * setup-command and detached-command environment, while `ROOMOTE_TASK_ID` is
 * present in task harness shells.
 */
function isInsideRoomoteSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.ROOMOTE_SANDBOX_SERVER_HOST?.trim() || env.ROOMOTE_TASK_ID?.trim(),
  );
}

function parseArguments() {
  const program = new Command();

  program
    .name('seed-demo')
    .description(
      'Insert idempotent demo data for Roomote task sandboxes and preview ' +
        'deployments. Refuses to run elsewhere unless --force is passed, ' +
        'and never runs against a production app environment.',
    )
    .option(
      '--force',
      'Run outside a sandbox or preview app environment (never in production)',
      false,
    )
    .addHelpText(
      'after',
      `
Examples:
  pnpm db:seed:demo            # inside a Roomote sandbox or with APP_ENV=preview
  pnpm db:seed:demo --force    # local testing against a development database`,
    );

  program.parse(process.argv);

  return program.opts<ScriptOptions>();
}

async function main() {
  const { force } = parseArguments();
  const inSandbox = isInsideRoomoteSandbox();
  const appEnv = resolveAppEnv(process.env);

  if (!inSandbox && appEnv === 'production') {
    console.error(
      'Refusing to seed demo data: the app environment resolves to "production".',
    );
    process.exit(1);
  }

  if (!inSandbox && appEnv !== 'preview' && !force) {
    console.error(
      'Refusing to seed demo data: not running inside a Roomote sandbox and ' +
        `the app environment resolves to "${appEnv}". ` +
        'Set APP_ENV=preview (or pass --force for local testing).',
    );
    process.exit(1);
  }

  console.log(
    `Seeding demo data (${inSandbox ? 'sandbox' : `app env: ${appEnv}`})...`,
  );

  const summary = await seedDemoData();

  for (const label of summary.created) {
    console.log(`  created ${label}`);
  }

  for (const label of summary.skipped) {
    console.log(`  exists  ${label}`);
  }

  console.log('Demo seed complete');
  process.exit(0);
}

main().catch((error) => {
  console.error('Failed to seed demo data:', error);
  process.exit(1);
});
