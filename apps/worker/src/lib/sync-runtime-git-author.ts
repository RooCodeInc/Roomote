import { execa } from 'execa';

import { sdk } from '@roomote/sdk/client';

export async function syncRuntimeGitAuthor(options: {
  runId: number;
  workingDirectory: string;
}): Promise<void> {
  const author = await sdk.taskRuns.getResolvedGitAuthor({
    runId: options.runId,
  });

  await execa('git', ['config', '--global', 'user.email', author.email], {
    cwd: options.workingDirectory,
  });
  await execa('git', ['config', '--global', 'user.name', author.name], {
    cwd: options.workingDirectory,
  });
}
