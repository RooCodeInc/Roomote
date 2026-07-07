import { Command } from 'commander';

import { db, environmentVariables, eq, users } from '@roomote/db/server';

interface ScriptOptions {
  email: string;
  name: string;
  value: string;
  userScoped?: boolean;
}

function parseArguments() {
  const program = new Command();

  program
    .name('create-env-var')
    .description('Create an encrypted environment variable')
    .version('0.1.0')
    .requiredOption('--email <email>', 'User email for attribution')
    .requiredOption('--name <name>', 'Name of the environment variable')
    .requiredOption('--value <value>', 'Value of the environment variable')
    .option('--user-scoped', 'Store the variable for only this user', false)
    .addHelpText(
      'after',
      `
Examples:
  pnpm development:create-env-var --email=user@example.com --name=OPENAI_API_KEY --value=sk-123
  pnpm development:create-env-var --email=user@example.com --name=FOO --value=bar --user-scoped`,
    );

  program.parse(process.argv);

  return program.opts<ScriptOptions>();
}

async function main() {
  try {
    const { email, name, value, userScoped } = parseArguments();

    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!user || user.deletedAt) {
      throw new Error(`No active user found for ${email}`);
    }

    const [envVar] = await db
      .insert(environmentVariables)
      .values({
        userId: userScoped ? user.id : null,
        name,
        value,
        createdByUserId: user.id,
        lastUpdatedByUserId: user.id,
      })
      .returning();

    console.log(envVar);
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

main();
