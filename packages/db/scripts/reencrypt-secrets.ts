// pnpm --filter @roomote/db development:reencrypt-secrets -- --dry-run
//
// Local counterpart of the `reencrypt-secrets` app-image command. See
// apps/docs/self-hosting/operations.mdx ("Rotate the encryption key").

import { runReencryptSecretsCli } from '@roomote/db/server';

process.exitCode = await runReencryptSecretsCli(process.argv.slice(2));
