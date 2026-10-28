/**
 * Operator command: re-encrypt stored secrets with the current ENCRYPTION_KEY
 * after a key rotation. Bundled to dist/reencrypt-secrets.js and run through
 * the app image entrypoint:
 *
 *   /roomote/.docker/app/entrypoint.sh reencrypt-secrets --dry-run
 */
import { runReencryptSecretsCli } from '@roomote/db/server';

process.exitCode = await runReencryptSecretsCli(process.argv.slice(2));
