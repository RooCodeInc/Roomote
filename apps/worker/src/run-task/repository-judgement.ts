import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { installGitHook } from '@roo-code/judgement';

/** Install only executable paths; run credentials are inherited at commit time. */
export async function installRepositoryJudgement(
  cwd: string,
  logger: Pick<Console, 'warn'> = console,
) {
  const cli = resolveJudgementCli();
  if (!cli) {
    logger.warn(
      '[judgement] Hook unavailable: build the worker to install Judgement.',
    );
    return;
  }
  try {
    await installGitHook({
      cwd,
      command: [process.execPath, cli, 'check', '--staged', '--hook'],
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    logger.warn(
      '[judgement] Could not install the repository hook; commits are not checked.',
    );
  }
}

export function resolveJudgementCli() {
  const workerDirectory = dirname(resolve(process.argv[1] ?? 'worker.js'));
  const candidates = [
    resolve(workerDirectory, 'judgement.js'),
    resolve(workerDirectory, '../dist/judgement.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
