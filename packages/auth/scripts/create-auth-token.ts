// pnpm --silent --filter @roomote/auth development:create-auth-token <email> [timeoutMs]

import { db, eq, users } from '@roomote/db/server';

import { createAuthToken } from '../src';

interface ParsedArgs {
  email: string;
  timeoutMs: number;
  output: 'token' | 'json';
}

function usage(): string {
  return [
    'Usage: pnpm --silent --filter @roomote/auth development:create-auth-token <email> [timeoutMs] [--json]',
    '',
    'Creates a user auth token for the single deployment.',
  ].join('\n');
}

function parseTimeout(value: string | undefined): number {
  if (!value) {
    return 3600;
  }

  const timeoutMs = parseInt(value, 10);

  if (isNaN(timeoutMs) || timeoutMs <= 0) {
    console.error('Invalid timeout: must be a positive number');
    process.exit(1);
  }

  return timeoutMs;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let output: ParsedArgs['output'] = 'token';

  for (const arg of argv) {
    if (arg === '--json') {
      output = 'json';
      continue;
    }

    positional.push(arg);
  }

  const [email, timeoutArg] = positional;

  if (!email) {
    console.error(usage());
    process.exit(1);
  }

  return { email, timeoutMs: parseTimeout(timeoutArg), output };
}

async function main() {
  const { email, timeoutMs, output } = parseArgs(process.argv.slice(2));

  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (!user || user.deletedAt) {
    console.error(`No active user found for ${email}`);
    process.exit(1);
  }

  const token = await createAuthToken({
    userId: user.id,
    timeoutMs,
  });

  if (output === 'json') {
    console.log(
      JSON.stringify({
        userId: user.id,
        email: user.email,
        token,
      }),
    );
    return;
  }

  console.log(token);
}

main().then(() => process.exit(0));
