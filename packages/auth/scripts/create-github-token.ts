// pnpm --silent --filter @roomote/auth development:create-github-token [email]

import { db, eq, users } from '@roomote/db/server';

import { createGitHubToken } from '../src';

async function main() {
  const email = process.argv[2];
  let token: string;

  if (email) {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!user || user.deletedAt) {
      console.error(`No active user found for ${email}`);
      process.exit(1);
    }

    token = await createGitHubToken({
      type: 'userId',
      userId: user.id,
    });
  } else {
    token = await createGitHubToken({ type: 'activeInstallation' });
  }

  console.log(token);
}

main().then(() => process.exit(0));
