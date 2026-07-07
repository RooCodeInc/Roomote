// npx dotenvx run -f ../../.env.local -- tsx scripts/read-env-vars.ts

import { Command } from 'commander';

import {
  db,
  environmentVariables,
  eq,
  isNull,
  stringifyDecryptedEnvVarValue,
  users,
} from '@roomote/db/server';
import { decryptSecrets } from '@roomote/db/encryption';

interface ScriptOptions {
  email?: string;
}

function parseArguments() {
  const program = new Command();

  program
    .name('read-env-vars')
    .description('Read and decrypt deployment-wide or user-scoped variables')
    .version('0.1.0')
    .option('--email <email>', 'Read variables scoped to this user')
    .addHelpText(
      'after',
      `
Examples:
  pnpm development:read-env-vars
  pnpm development:read-env-vars --email=user@example.com`,
    );

  program.parse(process.argv);

  return program.opts<ScriptOptions>();
}

async function main() {
  try {
    const { email } = parseArguments();

    let userId: string | null = null;
    if (email) {
      const user = await db.query.users.findFirst({
        where: eq(users.email, email),
      });

      if (!user || user.deletedAt) {
        throw new Error(`No active user found for ${email}`);
      }

      userId = user.id;
      console.log(`\nUser: ${user.email}`);
    } else {
      console.log('\nDeployment-wide variables');
    }

    const encryptedEnvVars = await db.query.environmentVariables.findMany({
      where: userId
        ? eq(environmentVariables.userId, userId)
        : isNull(environmentVariables.userId),
    });

    if (encryptedEnvVars.length === 0) {
      console.log('\nNo environment variables found.');
      process.exit(0);
    }

    console.log(
      `\nFound ${encryptedEnvVars.length} environment variable(s):\n`,
    );

    const decryptedEnvVars = await Promise.all(
      encryptedEnvVars.map(async (envVar) => {
        try {
          const decryptedValue = await decryptSecrets<string>(envVar.value);
          return {
            id: envVar.id,
            name: envVar.name,
            value:
              decryptedValue === null
                ? null
                : stringifyDecryptedEnvVarValue(decryptedValue),
            createdAt: envVar.createdAt,
            updatedAt: envVar.updatedAt,
          };
        } catch (error) {
          console.error(
            `Failed to decrypt env var ${envVar.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return {
            id: envVar.id,
            name: envVar.name,
            value: '[DECRYPTION FAILED]',
            createdAt: envVar.createdAt,
            updatedAt: envVar.updatedAt,
          };
        }
      }),
    );

    decryptedEnvVars.forEach((envVar) => {
      console.log(`ID: ${envVar.id}`);
      console.log(`Name: ${envVar.name}`);
      console.log(`Value: ${envVar.value}`);
      console.log(`Created: ${envVar.createdAt}`);
      console.log(`Updated: ${envVar.updatedAt}`);
      console.log('---');
    });

    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

main();
